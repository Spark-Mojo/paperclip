import { randomUUID } from "node:crypto";
import {
  connectionEventDeliveries,
  connectionGrants,
  externalObjects,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import {
  logActivity,
  publishActivity,
  type ActivityPublication,
} from "./activity-log.js";
import {
  createPaperclipCloudConnector,
  paperclipCloudConnectorConfigFromEnv,
  type PaperclipCloudConnector,
  type SealedConnectorEvents,
} from "./paperclip-cloud-connector.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import {
  dedupeKey,
  prQualifiesForSableSeat,
  seatCardTitle,
} from "./sable-seat-dispatch.js";
import { logger } from "../middleware/logger.js";

type LeasedEvent = SealedConnectorEvents["events"][number];
type GitHubBinding = {
  id: string;
  companyId: string;
  connectionId: string;
  grantId: string;
  subject: string;
  installationId: string;
  providerTenant: NonNullable<typeof connectionGrants.$inferSelect.providerTenant>;
};

export type GitHubConnectionEventPollResult = {
  leased: number;
  processed: number;
  duplicate: number;
  ignored: number;
  failed: number;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

function identifier(value: unknown): string | null {
  return typeof value === "string" && /^[1-9][0-9]{0,30}$/.test(value) ? value : null;
}

function isoDate(value: unknown): string | null {
  const candidate = boundedString(value, 100);
  if (!candidate || Number.isNaN(Date.parse(candidate))) return null;
  return new Date(candidate).toISOString();
}

function commitSha(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{40,64}$/i.test(value) ? value.toLowerCase() : null;
}

function githubUrl(value: unknown): string | null {
  const candidate = boundedString(value, 2_000);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "github.com" ? url.toString() : null;
  } catch {
    return null;
  }
}

function compact(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null && value !== undefined));
}

/**
 * Treat the sealed Cloud batch as an untrusted boundary. Cloud already normalizes
 * GitHub payloads, but the instance independently allowlists and bounds the small
 * reconciliation record that it persists and processes.
 */
function normalizeLeasedPayload(event: LeasedEvent): Record<string, unknown> {
  const payload = record(event.payload);
  const base = {
    event: boundedString(payload.event, 100),
    action: boundedString(payload.action, 100),
    installationId: identifier(payload.installationId),
    repositoryId: identifier(payload.repositoryId),
    repository: boundedString(payload.repository, 300),
    senderId: identifier(payload.senderId),
    senderLogin: boundedString(payload.senderLogin, 100),
  };
  if (event.event === "pull_request") {
    return compact({
      ...base,
      number: positiveInteger(payload.number),
      url: githubUrl(payload.url),
      state: boundedString(payload.state, 40),
      merged: payload.merged === true,
      mergedAt: isoDate(payload.mergedAt),
      updatedAt: isoDate(payload.updatedAt),
      headRef: boundedString(payload.headRef, 300),
      headSha: commitSha(payload.headSha),
      baseRef: boundedString(payload.baseRef, 300),
      baseSha: commitSha(payload.baseSha),
    });
  }
  if (event.event === "installation_repositories") {
    const repositoryIds = (value: unknown) => Array.isArray(value)
      ? value.slice(0, 1_000).flatMap((item) => identifier(item) ?? [])
      : [];
    return compact({
      ...base,
      repositorySelection: boundedString(payload.repositorySelection, 40),
      repositoriesAdded: repositoryIds(payload.repositoriesAdded),
      repositoriesRemoved: repositoryIds(payload.repositoriesRemoved),
    });
  }
  if (event.event === "installation") {
    return compact({
      ...base,
      accountId: identifier(payload.accountId),
      accountLogin: boundedString(payload.accountLogin, 100),
      repositorySelection: boundedString(payload.repositorySelection, 40),
    });
  }
  return compact(base);
}

function bindingRows(rows: Array<{
  grant: typeof connectionGrants.$inferSelect;
  connection: typeof toolConnections.$inferSelect;
}>): GitHubBinding[] {
  return rows.flatMap(({ grant, connection }) => {
    const config = record(connection.config);
    const oauth = record(config.oauth);
    if (config.sourceTemplateKey !== "github" || oauth.connectorProfile !== "github.code") return [];
    const github = grant.providerTenant?.github;
    if (!github || grant.status !== "active") return [];
    const subject = grant.kind === "agent" && grant.subjectAgentId
      ? `agent:${grant.subjectAgentId}`
      : grant.kind === "user" && grant.subjectUserId
        ? grant.subjectUserId
        : null;
    if (!subject) return [];
    return github.installationIds.map((installationId) => ({
      id: `${grant.id}_${installationId}`,
      companyId: grant.companyId,
      connectionId: connection.id,
      grantId: grant.id,
      subject,
      installationId,
      providerTenant: grant.providerTenant!,
    }));
  });
}

function githubSnapshotUpdate(payload: Record<string, unknown>) {
  const repository = stringValue(payload.repository);
  const number = positiveInteger(payload.number);
  if (!repository || !number) return null;
  const state = stringValue(payload.state) ?? "unknown";
  const merged = payload.merged === true;
  const [owner, repo, ...extra] = repository.split("/");
  if (!owner || !repo || extra.length > 0) return null;
  return {
    repository,
    owner,
    repo,
    number,
    externalId: `${repository}#pull/${number}`,
    state,
    merged,
    statusKey: merged ? "merged" : state === "closed" ? "closed" : "open",
    statusLabel: merged ? "Merged" : state === "closed" ? "Closed" : "Open",
    statusCategory: merged ? "succeeded" : state === "closed" ? "closed" : "open",
    statusTone: merged ? "success" : state === "closed" ? "muted" : "info",
    statusIconKey: merged ? "git-merge" : state === "closed" ? "x-circle" : "git-pull-request",
    data: {
      provider: "github",
      owner,
      repo,
      number,
      state,
      merged,
      ...(stringValue(payload.url) ? { url: stringValue(payload.url) } : {}),
      ...(stringValue(payload.mergedAt) ? { mergedAt: stringValue(payload.mergedAt) } : {}),
      ...(stringValue(payload.headRef) ? { headRef: stringValue(payload.headRef) } : {}),
      ...(stringValue(payload.headSha) ? { headSha: stringValue(payload.headSha) } : {}),
      ...(stringValue(payload.baseRef) ? { baseRef: stringValue(payload.baseRef) } : {}),
      ...(stringValue(payload.baseSha) ? { baseSha: stringValue(payload.baseSha) } : {}),
    },
    remoteVersion: stringValue(payload.updatedAt),
  } as const;
}

/**
 * SPA-13735 d22 (SPA-13818 rulings 2+3+4+5) — additive exported Sable-seat
 * PR dispatch seam. Pure dispatch logic (gates + card/summons shaping +
 * one-sided dedupe) driven entirely by injected deps: no Db, no network, no
 * live infra. The closure-private production path below shares this logic
 * via a dep bridge (default resolver + service.create); the production
 * pollOnce path, the dynamic issueService import and the default resolver
 * behavior are unchanged.
 *
 * Ruling 2: repo-qualified dispatch on opened/synchronize/reopened with NO
 * changedFiles gate (the leased pull_request allowlist carries no
 * changedFiles; a file list is opportunistic triage surface only, never a
 * gate). Fail-closed skips stay for malformed payloads only (bad action,
 * invalid PR ref, non-platform repo, resolver null).
 * Ruling 3: the null prAuthor pair is kept and fail-closed — never a
 * refuse-everyone fallback, never audit-flag-and-proceed. No sender→PR-author
 * linkage is invented here (the leased payload's sender fields are the EVENT
 * SENDER, not the PR author). Enrichment is SPA-13821, path precision is
 * SPA-13820.
 * Ruling 4: one-sided dedupeKey/idempotencyKey contract; no wait on SPA-13661.
 */

export type SableSeatPrSnapshot = {
  repository: string;
  owner: string;
  repo: string;
  number: number;
};

export type SableSeatDispatchInput = {
  companyId: string;
  action: string;
  changedFiles?: unknown;
  snapshot: SableSeatPrSnapshot;
};

export type SableSeatSummonsCreateInput = {
  title: string;
  prompt: string;
  detailsMarkdown: string;
  idempotencyKey: string;
  tags: string[];
  prAuthorActorId: string | null;
  prAuthorActorType: string | null;
};

export type SableSeatDispatchDeps = {
  resolveSeatCardIssue: (
    companyId: string,
    snapshot: SableSeatPrSnapshot,
    matchedPatterns: string[],
    key: string,
  ) => Promise<{ id: string } | null>;
  createSummons: (
    seatIssueId: string,
    summons: SableSeatSummonsCreateInput,
  ) => Promise<{ id: string } | null>;
  dispatchedKeys: Set<string>;
  logInfo: (fields: Record<string, unknown>, message: string) => void;
  logWarn: (fields: Record<string, unknown>, message: string) => void;
};

export type SableSeatDispatchResult = {
  dispatched: boolean;
  reason: string;
};

/** Platform repos that qualify for seat dispatch (case-insensitive). */
export function isSableSeatDispatchRepo(repository: unknown): boolean {
  return typeof repository === "string" &&
    repository.trim().toLowerCase() === "spark-mojo/paperclip";
}

export async function dispatchSableSeatSummonsForPullRequest(
  input: SableSeatDispatchInput,
  deps: SableSeatDispatchDeps,
): Promise<SableSeatDispatchResult> {
  const snapshot = input.snapshot;
  if (
    input.action !== "opened" &&
    input.action !== "synchronize" &&
    input.action !== "reopened"
  ) {
    deps.logInfo(
      { companyId: input.companyId, action: input.action },
      "sable-seat dispatch skipped: action not dispatchable",
    );
    return { dispatched: false, reason: "action_not_dispatchable" };
  }
  if (!isSableSeatDispatchRepo(snapshot.repository)) {
    deps.logInfo(
      { companyId: input.companyId, repository: snapshot.repository },
      "sable-seat dispatch skipped: repo not dispatchable",
    );
    return { dispatched: false, reason: "repo_not_dispatchable" };
  }
  const key = dedupeKey({
    owner: snapshot.owner,
    repo: snapshot.repo,
    number: snapshot.number,
  });
  if (!key) {
    deps.logWarn(
      { companyId: input.companyId },
      "sable-seat dispatch skipped: invalid PR ref",
    );
    return { dispatched: false, reason: "invalid_pr_ref" };
  }
  if (deps.dispatchedKeys.has(key)) {
    deps.logInfo(
      { companyId: input.companyId, repository: snapshot.repository, number: snapshot.number, dedupeKey: key },
      "sable-seat dispatch skipped: duplicate key already dispatched",
    );
    return { dispatched: false, reason: "duplicate_suppressed" };
  }
  // Opportunistic triage surface only — never a gate (ruling 2). Defensive
  // cap bounds a future allowlist entry; absent today, matchedPatterns is [].
  const rawFiles = Array.isArray(input.changedFiles)
    ? input.changedFiles.filter((file): file is string => typeof file === "string").slice(0, 200)
    : null;
  const matchedPatterns = rawFiles
    ? prQualifiesForSableSeat({ changedFiles: rawFiles }).matchedPatterns
    : [];
  const seatIssue = await deps.resolveSeatCardIssue(
    input.companyId,
    snapshot,
    matchedPatterns,
    key,
  );
  if (!seatIssue) {
    deps.logInfo(
      {
        companyId: input.companyId,
        repository: snapshot.repository,
        number: snapshot.number,
        dedupeKey: key,
      },
      "sable-seat dispatch skipped: no seat-card issue resolved for company",
    );
    return { dispatched: false, reason: "no_seat_card_issue" };
  }
  const ref = `${snapshot.owner}/${snapshot.repo}#${snapshot.number}`;
  const summons: SableSeatSummonsCreateInput = {
    title: seatCardTitle({ owner: snapshot.owner, repo: snapshot.repo, number: snapshot.number }),
    prompt: `Sable review requested for ${snapshot.repository}#${snapshot.number}.`,
    detailsMarkdown: [
      `Sable seat review for ${ref}.`,
      `PR: https://github.com/${snapshot.owner}/${snapshot.repo}/pull/${snapshot.number}`,
      `Matched surfaces: ${matchedPatterns.length > 0 ? matchedPatterns.join(", ") : "none (no changed-file signal on leased payload)"}.`,
    ].join("\n"),
    idempotencyKey: key,
    tags: ["seat-summons", "sable-seat"],
    // Ruling 3: unattributed is a logged dispatch, not a refuse-everyone
    // fallback and not audit-flag-and-proceed. The leased payload carries no
    // PR-author identity (sender fields are the event sender), so the null
    // pair is kept and the resolve guard fail-closes instead. Follow-ups:
    // enrichment SPA-13821, path precision SPA-13820.
    prAuthorActorId: null,
    prAuthorActorType: null,
  };
  try {
    const createdSummons = await deps.createSummons(seatIssue.id, summons);
    if (!createdSummons) {
      deps.logWarn(
        {
          companyId: input.companyId,
          repository: snapshot.repository,
          number: snapshot.number,
          dedupeKey: key,
          err: "summons create returned null",
        },
        "sable-seat dispatch skipped: summons create failed, fail-closed",
      );
      return { dispatched: false, reason: "summons_create_failed" };
    }
  } catch (error) {
    deps.logWarn(
      {
        companyId: input.companyId,
        repository: snapshot.repository,
        number: snapshot.number,
        dedupeKey: key,
        err: error instanceof Error ? error.message : "summons create failed",
      },
      "sable-seat dispatch skipped: summons create failed, fail-closed",
    );
    return { dispatched: false, reason: "summons_create_failed" };
  }
  deps.dispatchedKeys.add(key);
  deps.logInfo(
    {
      companyId: input.companyId,
      repository: snapshot.repository,
      number: snapshot.number,
      dedupeKey: key,
      seatIssueId: seatIssue.id,
    },
    "sable-seat dispatch filed seat card + summons",
  );
  return { dispatched: true, reason: "dispatched" };
}

export function githubConnectionEventService(
  db: Db,
  options: {
    connector?: PaperclipCloudConnector;
    env?: NodeJS.ProcessEnv;
    now?: () => Date;
    wakeup?: NonNullable<Parameters<typeof issueThreadInteractionService>[1]>["wakeup"];
  } = {},
) {
  const now = options.now ?? (() => new Date());
  let nextPollAt = 0;
  let emptyPolls = 0;

  async function activeBindings() {
    const rows = await db.select({ grant: connectionGrants, connection: toolConnections })
      .from(connectionGrants)
      .innerJoin(toolConnections, and(
        eq(toolConnections.id, connectionGrants.connectionId),
        eq(toolConnections.companyId, connectionGrants.companyId),
      ))
      .where(and(
        eq(connectionGrants.status, "active"),
        eq(toolConnections.status, "active"),
        eq(toolConnections.enabled, true),
      ));
    return bindingRows(rows);
  }

  async function defaultResolveSeatCardIssue(
    companyId: string,
    snapshot: NonNullable<ReturnType<typeof githubSnapshotUpdate>>,
    matchedPatterns: string[],
    key: string,
  ): Promise<{ id: string } | null> {
    // Real default resolver (SPA-13735 d19): file the seat card via
    // issues.create. Dynamic import (cycle precedent: issue-thread-interactions
    // is the static importer here; issues.ts reaches back via dynamic import,
    // e.g. issues.ts:11645/11757/13722 — verified ./issues.js path, not
    // invented). UNASSIGNED: no seat→assignee map exists in this codebase; the
    // Sable-seat owner comes from board context, so no agent id is invented
    // here. idempotencyKey = dedupeKey: the shared overlap guard with the
    // SPA-13661 arming path (both filers use the same key so one seat card
    // per PR event) — SPA-13661 is still comments-only, so until it reads
    // this key the guard is one-sided here, not yet mutual. On create failure
    // → log + return null (fail closed, no summons without a card).
    try {
      const { issueService } = await import("./issues.js");
      const issue = await issueService(db).create(companyId, {
        title: seatCardTitle({ owner: snapshot.owner, repo: snapshot.repo, number: snapshot.number }),
        description: [
          `Sable seat review for ${snapshot.owner}/${snapshot.repo}#${snapshot.number}.`,
          `PR: ${snapshot.repository}#${snapshot.number}`,
          `Matched surfaces: ${matchedPatterns.join(", ")}.`,
        ].join("\n"),
        status: "todo",
        priority: "medium",
        idempotencyKey: key,
      });
      return { id: issue.id };
    } catch (error) {
      logger.warn({
        err: error,
        companyId,
        repository: snapshot.repository,
        number: snapshot.number,
        dedupeKey: key,
      }, "sable-seat seat-card create failed: no summons without a card");
      return null;
    }
  }

  type SableSeatSummonsOptions = {
    createSeatSummons?: typeof issueThreadInteractionService;
    resolveSeatCardIssue?: (
      companyId: string,
      snapshot: NonNullable<ReturnType<typeof githubSnapshotUpdate>>,
      matchedPatterns: string[],
    ) => Promise<{ id: string } | null>;
    interactionService?: ReturnType<typeof issueThreadInteractionService>;
    wakeup?: NonNullable<Parameters<typeof issueThreadInteractionService>[1]>["wakeup"];
  };

  async function applyPullRequestEvent(
    companyId: string,
    event: LeasedEvent,
    seatOptions: SableSeatSummonsOptions = {},
  ) {
    const summonsOptions: SableSeatSummonsOptions = {
      createSeatSummons: seatOptions.createSeatSummons,
      resolveSeatCardIssue: seatOptions.resolveSeatCardIssue,
      interactionService: seatOptions.interactionService,
      wakeup: options.wakeup ?? seatOptions.wakeup,
    };
    const normalizedPayload = record(event.payload);
    const snapshot = githubSnapshotUpdate(normalizedPayload);
    if (!snapshot) return;
    const appliedAt = now();
    await db.update(externalObjects).set({
      statusKey: snapshot.statusKey,
      statusLabel: snapshot.statusLabel,
      statusCategory: snapshot.statusCategory,
      statusTone: snapshot.statusTone,
      statusIconKey: snapshot.statusIconKey,
      isTerminal: snapshot.merged || snapshot.state === "closed",
      data: sql`${externalObjects.data} || ${JSON.stringify(snapshot.data)}::jsonb`,
      remoteVersion: snapshot.remoteVersion,
      lastResolvedAt: appliedAt,
      lastChangedAt: appliedAt,
      nextRefreshAt: appliedAt,
      updatedAt: appliedAt,
    }).where(and(
      eq(externalObjects.companyId, companyId),
      eq(externalObjects.providerKey, "github"),
      eq(externalObjects.objectType, "pull_request"),
      sql`lower(${externalObjects.externalId}) = lower(${snapshot.externalId})`,
    ));
    if (snapshot.merged && event.action === "closed") {
      await issueThreadInteractionService(db, { wakeup: summonsOptions.wakeup })
        .sweepMergedPullRequestConfirmations([{
          companyId,
          owner: snapshot.owner,
          repo: snapshot.repo,
          number: snapshot.number,
        }]);
    }
    await maybeDispatchSableSeatSummons(
      companyId,
      normalizedPayload,
      snapshot,
      summonsOptions,
    );
  }

  /**
   * R1 automatic Sable seat dispatch (SPA-13735 d11; shared-logic bridge d22
   * per SPA-13818 rulings 2+3+4+5).
   *
   * Hook point: after the existing snapshot update in applyPullRequestEvent.
   * Runs on opened/synchronize/reopened with NO changedFiles gate (ruling 2:
   * the leased pull_request allowlist carries no changedFiles; a file list is
   * opportunistic triage surface only, never a gate). Dispatch reads the SAME
   * normalized payload object passed to githubSnapshotUpdate (never raw
   * event.payload, which would bypass the normalizeLeasedPayload allowlist).
   * Fail-closed skips stay for malformed payloads only (bad action, invalid
   * PR ref, non-platform repo, resolver null). Never add a GitHub API fetch
   * here.
   *
   * Author source: the leased payload's sender fields are the EVENT SENDER,
   * NOT the PR author. There is no author identity on the leased payload, so
   * the summons keeps the null prAuthorActor pair (ruling 3: never a
   * refuse-everyone fallback, never audit-flag-and-proceed; no
   * sender→PR-author linkage invented). The create path below uses the
   * {systemId} actor, which the d16 server derivation turns into the
   * absent/null pair, so the d10 route guard fail-closes pending the
   * enrichment leaf (SPA-13821; path precision SPA-13820) — never a guess
   * here.
   *
   * Coordination: dedupeKey is the shared overlap guard with the SPA-13661
   * arming path — both filers use the same key so one seat card per PR event
   * (ruling 4: one-sided here until SPA-13661 reads it; the dispatch passes
   * it as the interaction idempotencyKey, the arming path checks the same
   * key to avoid double-filing). Production idempotency beyond this call is
   * at the Db level (issue create idempotencyKey + interaction
   * idempotencyKey conflict handling); the dispatchedKeys set below is a
   * fresh per-call set, so production behavior on that surface is unchanged.
   *
   * Target resolution: the seat card needs an issue on this company to host
   * the summons interaction. The default resolver files the seat card via
   * issues.create (idempotencyKey=dedupeKey, unassigned — the Sable-seat
   * owner comes from board context, so no agent id is invented here). An
   * injected resolver may override it; absent any resolved issue the
   * dispatch fails closed (log + skip, no card). Documented, not
   * silent. This function is a thin bridge over the exported
   * dispatchSableSeatSummonsForPullRequest above (ruling 5): the
   * pollOnce path, the dynamic issueService import and the default resolver
   * behavior are unchanged.
   */
  async function maybeDispatchSableSeatSummons(
    companyId: string,
    payload: Record<string, unknown>,
    snapshot: NonNullable<ReturnType<typeof githubSnapshotUpdate>>,
    options: SableSeatSummonsOptions = {},
  ): Promise<{ dispatched: boolean; reason: string }> {
    const action = typeof payload.action === "string" ? payload.action : "";
    const serviceFactory = options.createSeatSummons ?? issueThreadInteractionService;
    const service = options.interactionService ?? serviceFactory(db, { wakeup: options.wakeup });
    const resolveSeatCardIssue: SableSeatDispatchDeps["resolveSeatCardIssue"] = options.resolveSeatCardIssue
      ? async (c, s, m) => options.resolveSeatCardIssue!(c, s as NonNullable<ReturnType<typeof githubSnapshotUpdate>>, m)
      : async (c, s, m, k) => defaultResolveSeatCardIssue(c, s as NonNullable<ReturnType<typeof githubSnapshotUpdate>>, m, k);
    return dispatchSableSeatSummonsForPullRequest(
      {
        companyId,
        action,
        changedFiles: (payload as { changedFiles?: unknown }).changedFiles,
        snapshot,
      },
      {
        resolveSeatCardIssue,
        createSummons: async (seatIssueId, summons) => {
          const created = await service.create(
            { id: seatIssueId, companyId },
            {
              kind: "request_confirmation",
              idempotencyKey: summons.idempotencyKey,
              continuationPolicy: "none",
              title: summons.title,
              payload: {
                version: 1,
                prompt: summons.prompt,
                detailsMarkdown: summons.detailsMarkdown,
                // d15/d16 extended the schema: tags/prAuthor survive create
                // AND hydrate, and author is server-derived (the
                // {systemId} actor below yields the absent/null pair) — so
                // these tags ARE detectable by isSeatSummonsInteraction and
                // the d10 guard fail-closes on the null pair.
                tags: summons.tags,
                prAuthorActorId: summons.prAuthorActorId,
                prAuthorActorType: summons.prAuthorActorType,
              } as unknown as Extract<
                import("@paperclipai/shared").CreateIssueThreadInteraction,
                { kind: "request_confirmation" }
              >["payload"],
            },
            { systemId: "system:sable-seat-dispatch" },
          );
          return { id: created.id };
        },
        dispatchedKeys: new Set<string>(),
        logInfo: (fields, message) => logger.info(fields, message),
        logWarn: (fields, message) => logger.warn(fields, message),
      },
    );
  }

  async function applyInstallationEvent(database: Db, binding: GitHubBinding, event: LeasedEvent) {
    // Bindings are loaded before the Cloud request. Lock and read the grant
    // again so a refresh completed during that request cannot be overwritten.
    const [currentGrant] = await database.select().from(connectionGrants).where(and(
      eq(connectionGrants.id, binding.grantId),
      eq(connectionGrants.companyId, binding.companyId),
      eq(connectionGrants.status, "active"),
    )).for("update").limit(1);
    const currentProviderTenant = currentGrant?.providerTenant;
    const github = currentProviderTenant?.github;
    if (!github) return;
    // A newly bound instance can receive installation events from before OAuth
    // verified its repository list. Those events must not erase newer access.
    if (Date.parse(github.lastAccessRefreshAt ?? "") > Date.parse(event.createdAt)) {
      await database.update(connectionGrants).set({
        providerTenant: {
          ...currentProviderTenant,
          github: { ...github, lastWebhookAt: now().toISOString(), webhookHealth: "healthy" },
        },
        updatedAt: now(),
      }).where(and(eq(connectionGrants.id, binding.grantId), eq(connectionGrants.companyId, binding.companyId)));
      return;
    }
    const unavailable = event.event === "installation" && (event.action === "deleted" || event.action === "suspend");
    const installationIds = unavailable
      ? github.installationIds.filter((id) => id !== binding.installationId)
      : [...new Set([...github.installationIds, binding.installationId])];
    const added = Array.isArray(event.payload.repositoriesAdded) ? event.payload.repositoriesAdded.length : 0;
    const removed = Array.isArray(event.payload.repositoriesRemoved) ? event.payload.repositoriesRemoved.length : 0;
    const repositoryCount = Math.max(
      0,
      unavailable && installationIds.length === 0
        ? 0
        : unavailable
          ? github.repositoryCount
          : github.repositoryCount + added - removed,
    );
    const providerTenant = {
      ...currentProviderTenant,
      github: {
        ...github,
        // Lifecycle webhooks carry IDs, not the user token’s complete repository view.
        // Discard the snapshot until Refresh access verifies it again.
        accessRevision: randomUUID(),
        repositories: undefined,
        installationIds,
        installationCount: installationIds.length,
        repositoryCount,
        repositorySelection: repositoryCount === 0 ? "none" as const : github.repositorySelection,
        lastWebhookAt: now().toISOString(),
        webhookHealth: unavailable ? "unhealthy" as const : "healthy" as const,
      },
    };
    await database.update(connectionGrants).set({ providerTenant, updatedAt: now() })
      .where(and(eq(connectionGrants.id, binding.grantId), eq(connectionGrants.companyId, binding.companyId)));
    await database.update(toolConnections).set({
      healthStatus: unavailable ? "failed" : "ok",
      healthMessage: unavailable
        ? "GitHub installation access was removed or suspended. Manage repository access on GitHub."
        : "GitHub installation and repository access are available.",
      healthCheckedAt: now(),
      lastHealthAt: now(),
      lastError: unavailable ? "GitHub installation unavailable" : null,
      updatedAt: now(),
    }).where(and(eq(toolConnections.id, binding.connectionId), eq(toolConnections.companyId, binding.companyId)));
  }

  async function processForCompany(companyId: string, bindings: GitHubBinding[], event: LeasedEvent) {
    const receiptAt = now();
    const normalizedEvent = { ...event, payload: normalizeLeasedPayload(event) };
    const [receipt] = await db.insert(connectionEventDeliveries).values({
      companyId,
      provider: event.provider,
      providerDeliveryId: event.id,
      event: event.event,
      action: event.action,
      installationId: event.installationId,
      repositoryId: event.repositoryId,
      normalizedPayload: normalizedEvent.payload,
      providerCreatedAt: new Date(event.createdAt),
      status: "received",
      attempts: 1,
      updatedAt: receiptAt,
    }).onConflictDoNothing().returning();
    if (!receipt) {
      const [existing] = await db.select().from(connectionEventDeliveries).where(and(
        eq(connectionEventDeliveries.companyId, companyId),
        eq(connectionEventDeliveries.provider, event.provider),
        eq(connectionEventDeliveries.providerDeliveryId, event.id),
      )).limit(1);
      if (existing?.status === "processed") return "duplicate" as const;
      await db.update(connectionEventDeliveries).set({
        status: "received",
        attempts: sql`${connectionEventDeliveries.attempts} + 1`,
        lastError: null,
        updatedAt: receiptAt,
      }).where(eq(connectionEventDeliveries.id, existing!.id));
    }
    const postCommitPublications: ActivityPublication[] = [];
    try {
      const applyAndFinalize = async (database: Db) => {
        if (event.event === "pull_request") await applyPullRequestEvent(companyId, normalizedEvent, { wakeup: options.wakeup });
        if (event.event === "installation" || event.event === "installation_repositories") {
          for (const binding of bindings) await applyInstallationEvent(database, binding, normalizedEvent);
        } else {
          const touchedAt = now();
          for (const binding of bindings) {
            const github = binding.providerTenant.github;
            if (!github) continue;
            await database.update(connectionGrants).set({
              // Update only webhook fields; a concurrent access/token refresh
              // owns the remaining metadata and must not be replaced here.
              providerTenant: sql`jsonb_set(${connectionGrants.providerTenant}, '{github}',
                (${connectionGrants.providerTenant}->'github') || ${JSON.stringify({
                  lastWebhookAt: touchedAt.toISOString(), webhookHealth: "healthy",
                })}::jsonb)`,
              updatedAt: touchedAt,
            }).where(and(
              eq(connectionGrants.id, binding.grantId),
              eq(connectionGrants.companyId, companyId),
              eq(connectionGrants.status, "active"),
              sql`${connectionGrants.providerTenant}->'github' is not null`,
            ));
          }
        }
        const finishedAt = now();
        await database.update(connectionEventDeliveries).set({
          status: "processed",
          processedAt: finishedAt,
          lastError: null,
          updatedAt: finishedAt,
        }).where(and(
          eq(connectionEventDeliveries.companyId, companyId),
          eq(connectionEventDeliveries.provider, event.provider),
          eq(connectionEventDeliveries.providerDeliveryId, event.id),
        ));
        await logActivity(database, {
          companyId,
          actorType: "system",
          actorId: "system:github-webhook",
          action: "tool_connection.webhook_processed",
          entityType: "tool_connection",
          entityId: bindings[0]!.connectionId,
          details: {
            provider: "github",
            event: event.event,
            action: event.action,
            deliveryId: event.id,
            installationId: event.installationId,
            repositoryId: event.repositoryId,
          },
        }, postCommitPublications);
      };
      if (event.event === "installation" || event.event === "installation_repositories") {
        await db.transaction(async (tx) => applyAndFinalize(tx as unknown as Db));
      } else {
        await applyAndFinalize(db);
      }
    } catch (error) {
      await db.update(connectionEventDeliveries).set({
        status: "failed",
        lastError: error instanceof Error ? error.message.slice(0, 500) : "GitHub event processing failed",
        updatedAt: now(),
      }).where(and(
        eq(connectionEventDeliveries.companyId, companyId),
        eq(connectionEventDeliveries.provider, event.provider),
        eq(connectionEventDeliveries.providerDeliveryId, event.id),
      ));
      throw error;
    }
    // Persistence is complete at this point (and installation deltas have
    // committed). A synchronous live-event subscriber must not turn that
    // durable success back into a retryable receipt and replay the delta.
    for (const publication of postCommitPublications) {
      try {
        publishActivity(publication);
      } catch (error) {
        logger.warn({
          err: error,
          companyId,
          providerDeliveryId: event.id,
        }, "GitHub webhook activity publication failed after commit");
      }
    }
    return "processed" as const;
  }

  return {
    async pollOnce(): Promise<GitHubConnectionEventPollResult> {
      if (now().getTime() < nextPollAt) {
        return { leased: 0, processed: 0, duplicate: 0, ignored: 0, failed: 0 };
      }
      const bindings = await activeBindings();
      if (bindings.length === 0) {
        nextPollAt = now().getTime() + 5 * 60_000;
        return { leased: 0, processed: 0, duplicate: 0, ignored: 0, failed: 0 };
      }
      const config = options.connector ? null : paperclipCloudConnectorConfigFromEnv(options.env);
      const connector = options.connector ?? (config ? createPaperclipCloudConnector({ config }) : null);
      if (!connector) {
        nextPollAt = now().getTime() + 5 * 60_000;
        return { leased: 0, processed: 0, duplicate: 0, ignored: 0, failed: 0 };
      }
      const first = bindings[0]!;
      const lease = await connector.leaseEvents({ subject: first.subject, companyId: first.companyId });
      if (!lease) {
        emptyPolls += 1;
        nextPollAt = now().getTime() + Math.min(5 * 60_000, 5_000 * (2 ** Math.min(emptyPolls, 6)));
        return { leased: 0, processed: 0, duplicate: 0, ignored: 0, failed: 0 };
      }
      emptyPolls = 0;
      nextPollAt = now().getTime() + 5_000;
      const result: GitHubConnectionEventPollResult = {
        leased: lease.events.length,
        processed: 0,
        duplicate: 0,
        ignored: 0,
        failed: 0,
      };
      const acknowledge: string[] = [];
      for (const event of lease.events) {
        const matched = bindings.filter((binding) => event.bindingIds.includes(binding.id));
        if (matched.length === 0) {
          result.ignored += 1;
          acknowledge.push(event.id);
          continue;
        }
        try {
          const companies = new Map<string, GitHubBinding[]>();
          for (const binding of matched) companies.set(binding.companyId, [...(companies.get(binding.companyId) ?? []), binding]);
          for (const [companyId, companyBindings] of companies) {
            const status = await processForCompany(companyId, companyBindings, event);
            result[status] += 1;
          }
          acknowledge.push(event.id);
          if (event.event === "installation" && (event.action === "deleted" || event.action === "suspend")) {
            await Promise.all(matched.map((binding) => connector.setWebhookBinding({
              subject: binding.subject,
              companyId: binding.companyId,
              id: binding.id,
              installationId: binding.installationId,
              connectionId: binding.connectionId,
              grantId: binding.grantId,
              active: false,
            })));
          }
        } catch {
          result.failed += 1;
        }
      }
      if (acknowledge.length > 0) {
        await connector.acknowledgeEvents({
          subject: first.subject,
          companyId: first.companyId,
          leaseId: lease.leaseId,
          deliveryIds: acknowledge,
        });
      }
      return result;
    },
  };
}
