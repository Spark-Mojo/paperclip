import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { getConversationOwnershipBlocker } from "../services/conversation-continuation.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("SPA-12991 execution-owner lease reconciliation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;
  let issueId!: string;

  beforeEach(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("spa-12991-lease-recon-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "SPA-12991",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Lease reconciliation agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const [issue] = await db.insert(issues).values({ companyId, title: "SPA-12991" })
      .returning({ id: issues.id });
    issueId = issue!.id;
  }, 180_000);

  afterEach(async () => {
    await tempDb?.cleanup();
    tempDb = null;
  }, 60_000);

  async function seedCancelledRun(): Promise<string> {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "cancelled",
      runtimeMode: "legacy",
      nativeIssueId: null,
      contextSnapshot: { issueId, taskId: issueId },
      runnerProfileJson: { adapterDispatch: { adapterType: "opencode_local" } },
      processPid: null,
      processGroupId: null,
      createdAt: new Date(),
    });
    return id;
  }

  it("clears the hold for a cancelled run whose lease expired with failed cleanup", async () => {
    const runId = await seedCancelledRun();
    await db.insert(environmentLeases).values({
      companyId,
      heartbeatRunId: runId,
      status: "expired",
      expiresAt: new Date("2020-01-01T00:00:00Z"),
      releasedAt: new Date("2020-01-02T00:00:00Z"),
      cleanupStatus: "failed",
    });
    expect(await getConversationOwnershipBlocker(db, companyId, issueId)).toBeNull();
  }, 180_000);

  it("does NOT clear the hold for a cancelled run with a held lease", async () => {
    const runId = await seedCancelledRun();
    await db.insert(environmentLeases).values({
      companyId,
      heartbeatRunId: runId,
      status: "active",
    });
    expect(await getConversationOwnershipBlocker(db, companyId, issueId))
      .toMatchObject({ runId, cause: "execution_owner_active" });
  }, 180_000);
});
