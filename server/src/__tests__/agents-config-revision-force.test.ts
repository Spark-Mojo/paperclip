import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentConfigRevisions,
  agents,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres revision-force tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

describeEmbeddedPostgres("agent service revision force flag (SPA-5925)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-revision-force-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentConfigRevisions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(adapterConfig: Record<string, unknown>) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Test Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig,
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("skips the revision row when adapterConfig is unchanged and no force flag is set", async () => {
    const { agentId } = await seedAgent({
      instructionsBundleMode: "managed",
      instructionsRootPath: "/tmp/agent-1",
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: "/tmp/agent-1/AGENTS.md",
    });

    const services = agentService(db);
    await services.update(agentId, { adapterConfig: {} });

    const rows = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agentId));
    expect(rows).toHaveLength(0);
  });

  it("writes a revision row when force is true even if the resulting adapterConfig is unchanged", async () => {
    // SPA-5925: a PUT /instructions-bundle/file that lands byte-identical
    // adapterConfig must still produce an audit row, because the file on
    // disk is the source of truth and a content edit can be invisible at the
    // adapterConfig snapshot layer.
    const seedAdapterConfig = {
      instructionsBundleMode: "managed",
      instructionsRootPath: "/tmp/agent-1",
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: "/tmp/agent-1/AGENTS.md",
    };
    const { agentId } = await seedAgent(seedAdapterConfig);

    const services = agentService(db);
    // Round-trip the seed through the same normalization the service uses so
    // the post-update snapshot is byte-identical to the pre-update snapshot.
    // Passing a literal `{}` here triggers a real diff in the normalized
    // adapterConfig shape (the secret-binding sync step writes keys back),
    // which is not what the route handler does — the bundle PUT always passes
    // the full `result.adapterConfig` from `instructions.writeFile`.
    await services.update(
      agentId,
      { adapterConfig: seedAdapterConfig },
      {
        recordRevision: {
          source: "instructions_bundle_file_put",
          createdByUserId: "local-board",
          force: true,
        },
      },
    );

    const rows = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("instructions_bundle_file_put");
    expect(rows[0]?.changedKeys).toEqual(["instructionsFileContent"]);
    expect(rows[0]?.createdByUserId).toBe("local-board");
  });

  it("still writes a revision row on a non-empty adapterConfig diff even without the force flag", async () => {
    // Regression guard for the prior behavior: a real config edit must keep
    // auditing, and the new force flag must not change that path.
    const { agentId } = await seedAgent({
      instructionsBundleMode: "managed",
      instructionsRootPath: "/tmp/agent-1",
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: "/tmp/agent-1/AGENTS.md",
    });

    const services = agentService(db);
    await services.update(
      agentId,
      { adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: "/tmp/agent-2" } },
      { recordRevision: { source: "instructions_path_patch" } },
    );

    const rows = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("instructions_path_patch");
    expect(rows[0]?.changedKeys).toContain("adapterConfig");
  });
});