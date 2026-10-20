import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  instanceSettings,
  issueRelations,
  issueThreadInteractions,
  issues,
  projectWorkspaces,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import type { CreateIssueThreadInteraction } from "@paperclipai/shared";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  evaluateSeatSummonsResolve,
  getSeatSummonsAuthor,
  isSeatSummonsHydratedInteraction,
} from "../services/seat-summons-self-resolve-guard.js";

// SPA-13735 d15 (Ty direction, escalation SPA-13777): schema extension lands
// FIRST as the additive foundation. requestConfirmationPayloadSchema gains
// additive OPTIONAL `tags` / `prAuthorActorId` / `prAuthorActorType`; the
// server derives the author pair at create time and IGNORES any
// client-supplied value. Legacy rows (version+prompt only) parse unchanged.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("seat-summons schema roundtrip (SPA-13735 d15)", () => {
  let db!: ReturnType<typeof createDb>;
  let interactionsSvc!: ReturnType<typeof issueThreadInteractionService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-seat-summons-roundtrip-");
    db = createDb(tempDb.connectionString);
    interactionsSvc = issueThreadInteractionService(db);
  }, 90_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(heartbeatRuns);
    await db.delete(workspaceOperations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue() {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({ id: goalId, companyId, title: "Summons roundtrip", level: "task", status: "active" });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Seat summons parent",
      status: "in_progress",
      priority: "medium",
    });
    return { companyId, issueId };
  }

  it("round-trips tags plus server-derived author through create+hydrate", async () => {
    const { companyId, issueId } = await seedIssue();
    const authorAgentId = randomUUID();
    await db.insert(agents).values({
      id: authorAgentId,
      companyId,
      name: "SeatAuthor",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const created = await interactionsSvc.create(
      { id: issueId, companyId },
      {
        kind: "request_confirmation",
        payload: {
          version: 1,
          prompt: "Take the seat?",
          tags: ["seat-summons", "sable-seat"],
        },
      } as CreateIssueThreadInteraction,
      { agentId: authorAgentId },
    );

    const hydrated = await interactionsSvc.getForIssue({ id: issueId, companyId }, created.id);
    expect(hydrated.kind).toBe("request_confirmation");
    if (hydrated.kind !== "request_confirmation") throw new Error("expected request_confirmation");
    expect(hydrated.payload.tags).toEqual(["seat-summons", "sable-seat"]);
    expect(hydrated.payload.prAuthorActorId).toBe(authorAgentId);
    expect(hydrated.payload.prAuthorActorType).toBe("agent");
    expect(getSeatSummonsAuthor(hydrated)).toEqual({
      prAuthorActorId: authorAgentId,
      prAuthorActorType: "agent",
    });
    expect(isSeatSummonsHydratedInteraction(hydrated)).toBe(true);
  });

  it("spoof: forged client prAuthorActorId is overwritten by the server-derived actor", async () => {
    const { companyId, issueId } = await seedIssue();
    const realAgentId = randomUUID();
    await db.insert(agents).values({
      id: realAgentId,
      companyId,
      name: "SeatAuthor",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const created = await interactionsSvc.create(
      { id: issueId, companyId },
      {
        kind: "request_confirmation",
        payload: {
          version: 1,
          prompt: "Take the seat?",
          tags: ["seat-summons"],
          prAuthorActorId: "forged-attacker-id",
          prAuthorActorType: "agent",
        },
      } as unknown as CreateIssueThreadInteraction,
      { agentId: realAgentId },
    );

    const hydrated = await interactionsSvc.getForIssue({ id: issueId, companyId }, created.id);
    expect(hydrated.kind).toBe("request_confirmation");
    if (hydrated.kind !== "request_confirmation") throw new Error("expected request_confirmation");
    expect(hydrated.payload.prAuthorActorId).toBe(realAgentId);
    expect(hydrated.payload.prAuthorActorId).not.toBe("forged-attacker-id");
    expect(hydrated.payload.prAuthorActorType).toBe("agent");
  });

  it("spoof: forged client prAuthorActorType string is rejected or overwritten", async () => {
    const { companyId, issueId } = await seedIssue();
    const realAgentId = randomUUID();
    await db.insert(agents).values({
      id: realAgentId,
      companyId,
      name: "SeatAuthor",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const forged = {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Take the seat?",
        tags: ["seat-summons"],
        prAuthorActorId: realAgentId,
        prAuthorActorType: "board",
      },
    } as unknown as CreateIssueThreadInteraction;
    // Forged type strings fail parse (schema enum), before the create path
    // is ever reached — rejection, not overwrite, for this branch.
    await expect(
      interactionsSvc.create(
        { id: issueId, companyId },
        forged,
        { agentId: realAgentId },
      ),
    ).rejects.toThrow(/prAuthorActorType/);
  });

  it("system-authored brick: null pair when no agent/user principal keeps the guard fail-closed", async () => {
    const { companyId, issueId } = await seedIssue();
    const created = await interactionsSvc.create(
      { id: issueId, companyId },
      {
        kind: "request_confirmation",
        payload: {
          version: 1,
          prompt: "Take the seat?",
          tags: ["seat-summons"],
        },
      } as CreateIssueThreadInteraction,
      { systemId: "maintenance-sweep" },
    );

    const hydrated = await interactionsSvc.getForIssue({ id: issueId, companyId }, created.id);
    expect(hydrated.kind).toBe("request_confirmation");
    if (hydrated.kind !== "request_confirmation") throw new Error("expected request_confirmation");
    // No agent/user principal: no "system" brick is stored; the guard sees a
    // missing author and fail-closes, while the summons is still detected.
    expect(getSeatSummonsAuthor(hydrated)).toBeNull();
    expect(isSeatSummonsHydratedInteraction(hydrated)).toBe(true);
    expect(
      evaluateSeatSummonsResolve({
        isSummons: true,
        resolverActorId: randomUUID(),
        resolverActorType: "user",
        prAuthorActorId: hydrated.payload.prAuthorActorId ?? null,
        prAuthorActorType: hydrated.payload.prAuthorActorType ?? null,
        creatorAgentId: null,
        creatorUserId: "local-board",
      }).allowed,
    ).toBe(false);
  });

  it("system-authored dispatch shape: EXACT null pair parses and create+hydrate succeeds", async () => {
    const { companyId, issueId } = await seedIssue();
    // Production shape from github-connection-events.ts dispatch: the leased
    // payload carries no PR-author identity, so the summons payload emits the
    // EXACT null pair. The schema must accept null (nullable) — previously
    // .optional() only rejected this and killed every system-authored summons.
    const created = await interactionsSvc.create(
      { id: issueId, companyId },
      {
        kind: "request_confirmation",
        payload: {
          version: 1,
          prompt: "Sable review requested for owner/repo#1.",
          detailsMarkdown: "Matched surfaces: foo.",
          tags: ["seat-summons", "sable-seat"],
          prAuthorActorId: null,
          prAuthorActorType: null,
        },
      } as unknown as CreateIssueThreadInteraction,
      { systemId: "system:sable-seat-dispatch" },
    );

    const hydrated = await interactionsSvc.getForIssue({ id: issueId, companyId }, created.id);
    expect(hydrated.kind).toBe("request_confirmation");
    if (hydrated.kind !== "request_confirmation") throw new Error("expected request_confirmation");
    expect(hydrated.payload.tags).toEqual(["seat-summons", "sable-seat"]);
    // Create path erases client values and derives server-side: system actor
    // has no agent/user principal, so no author is stored and the guard
    // fail-closes (trust boundary intact).
    expect(getSeatSummonsAuthor(hydrated)).toBeNull();
    expect(isSeatSummonsHydratedInteraction(hydrated)).toBe(true);
  });

  it("legacy old-shape rows hydrate fine and the summons guard does not fire", async () => {
    const { companyId, issueId } = await seedIssue();
    const interactionId = randomUUID();

    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: { kind: "none" },
      payload: {
        version: 1,
        prompt: "Proceed with the current draft?",
      },
      createdByUserId: "local-board",
    });

    const hydrated = await interactionsSvc.getForIssue({ id: issueId, companyId }, interactionId);
    expect(hydrated.kind).toBe("request_confirmation");
    if (hydrated.kind !== "request_confirmation") throw new Error("expected request_confirmation");
    expect(hydrated.payload).toMatchObject({ version: 1, prompt: "Proceed with the current draft?" });
    expect(getSeatSummonsAuthor(hydrated)).toBeNull();
    expect(isSeatSummonsHydratedInteraction(hydrated)).toBe(false);
  });
});
