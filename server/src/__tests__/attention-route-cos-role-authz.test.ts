import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  companies,
  createDb,
  inboxDismissals,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { attentionRoutes } from "../routes/attention.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres attention route CoS-role authz tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("attention route board-or-CoS-role authz", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attention-cos-authz-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(inboxDismissals);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix = "ACO") {
    const companyId = randomUUID();
    const cosAgentId = randomUUID();
    const pmAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Co`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: cosAgentId,
        companyId,
        name: "Chief of Staff",
        role: "ceo",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: pmAgentId,
        companyId,
        name: "Planner",
        role: "pm",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    return { companyId, cosAgentId, pmAgentId };
  }

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", attentionRoutes(db));
    testApp.use(errorHandler);
    return testApp;
  }

  function agentActor(input: { agentId: string; companyId: string }) {
    return {
      type: "agent",
      source: "agent_key",
      companyId: input.companyId,
      agentId: input.agentId,
      keyId: randomUUID(),
      runId: null,
    };
  }

  it("returns the feed for a ceo-role agent actor (SPA-4905 opt-a)", async () => {
    const { companyId } = await seedCompany("AC1");
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: { title: "Pending decision" },
    });

    const rows = await db.select().from(agents);
    const ceoRow = rows.find((row) => row.role === "ceo")!;
    const res = await request(app(agentActor({ agentId: ceoRow.id, companyId })))
      .get(`/api/companies/${companyId}/attention`)
      .expect(200);

    expect(res.body).toMatchObject({ companyId, totalCount: 1 });
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      sourceKind: "approval",
      subject: { kind: "approval", id: approvalId },
    });
  });

  it("gives an agent actor the unfiltered company feed (no per-user dismissal filtering)", async () => {
    const { companyId } = await seedCompany("AC2");
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: { title: "Board-dismissed but still visible to agents" },
    });
    // The board user dismissed this item; the agent feed must not inherit
    // that user's dismissal state.
    await db.insert(inboxDismissals).values({
      companyId,
      userId: "board-user",
      itemKey: `attention:approval:${approvalId}`,
      kind: "dismiss",
    });

    const ceoRow = (await db.select().from(agents)).find((row) => row.role === "ceo")!;
    const res = await request(app(agentActor({ agentId: ceoRow.id, companyId })))
      .get(`/api/companies/${companyId}/attention`)
      .expect(200);

    expect(res.body.items.map((item: { sourceKind: string }) => item.sourceKind)).toContain(
      "approval",
    );
  });

  it("rejects a non-ceo-role agent with the assertBoard error shape", async () => {
    const { companyId } = await seedCompany("AC3");
    const pmRow = (await db.select().from(agents)).find((row) => row.role === "pm")!;
    await request(app(agentActor({ agentId: pmRow.id, companyId })))
      .get(`/api/companies/${companyId}/attention`)
      .expect(403, { error: "Board access required" });
  });

  it("keeps cross-company agents blocked by assertCompanyAccess", async () => {
    const { companyId } = await seedCompany("AC4");
    const otherCompanyId = randomUUID();
    const otherCosAgentId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co",
      issuePrefix: "OTH",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: otherCosAgentId,
      companyId: otherCompanyId,
      name: "Other Chief of Staff",
      role: "ceo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // A ceo-role agent whose company differs from the path company: the
    // company-access guard fires before any role lookup.
    await request(
      app(agentActor({ agentId: otherCosAgentId, companyId: otherCompanyId })),
    )
      .get(`/api/companies/${companyId}/attention`)
      .expect(403, { error: "Agent key cannot access another company" });
  });

  it("preserves board-actor behavior including the userId 403 fallback", async () => {
    const { companyId } = await seedCompany("AC5");

    await request(
      app({
        type: "board",
        source: "local_implicit",
        userId: "board-user",
        companyIds: [companyId],
        isInstanceAdmin: false,
      }),
    )
      .get(`/api/companies/${companyId}/attention`)
      .expect(200);

    // Board actor without user context keeps its dedicated 403.
    await request(
      app({
        type: "board",
        source: "local_implicit",
        companyIds: [companyId],
        isInstanceAdmin: false,
      }),
    )
      .get(`/api/companies/${companyId}/attention`)
      .expect(403, { error: "Board user context required" });
  });
});
