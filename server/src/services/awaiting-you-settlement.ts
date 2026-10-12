import { and, asc, eq, isNotNull, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import { isAgentStatusInvokable } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { queueIssueAssignmentWakeup } from "./issue-assignment-wakeup.js";

/**
 * SPA-11242: periodic settlement of fully-answered user-owned (AWAITING-YOU)
 * cards. A user-owned card whose decision interactions are all resolved is
 * handed back to its live filing agent, or auto-closed when no live filer
 * exists so blocked dependents can unblock and wake. Cards whose payload
 * carries `requiresManualAction: true` always stay open.
 *
 * SPA-11924: the auto-close arm no longer fires on a work-receipt-free path,
 * and the hand-back arm is no longer dead code. See the two corrections below.
 *
 * Idempotency: a handed-back card has an agent assignee and a closed card is
 * terminal, so neither matches the candidate query on the next sweep. A card
 * withheld for want of a receipt DOES stay a candidate, so it is never given a
 * card comment — the sweep only counts and logs it, or it would append a
 * comment every 30 seconds forever.
 */

/**
 * SPA-11924 correction 1 — an administrative outcome is not an answer.
 *
 * The old predicate was `status !== "pending"`, which counted `expired`
 * (nobody ever responded), `cancelled` and `withdrawn` (the filing agent gave
 * up) as "resolved". Only a real decision releases the human owner:
 * `answered` / `accepted` / `rejected`.
 */
export const AFFIRMATIVE_RESOLUTION_STATUSES = new Set<string>([
  "answered",
  "accepted",
  "rejected",
]);

/**
 * SPA-11924 correction 2 — `done` requires a positive work receipt.
 *
 * Settling is necessary but not sufficient to close. A rejection is a real
 * answer (the human decided NOT to proceed) and an `ask_user_questions` answer
 * is a real answer, but neither is evidence that the requested work happened,
 * so neither may write `done`. An accepted confirmation is the receipt: a
 * human explicitly authorised the action, and the row records that outcome.
 */
export const SETTLEMENT_CLOSE_RECEIPT_STATUS = "accepted";

/** Fail-closed: an absent result object carries no contradictory outcome. */
function readRecordedOutcome(interaction: SettlementInteraction): string | null {
  const result =
    interaction.result && typeof interaction.result === "object"
      ? (interaction.result as Record<string, unknown>)
      : null;
  return typeof result?.["outcome"] === "string" ? result["outcome"] : null;
}

/**
 * At least one decision was genuinely made. Administrative-only cards
 * (expired / cancelled / withdrawn) do not settle and keep their human owner.
 */
export function hasAffirmativeResolution(
  resolved: SettlementInteraction[],
): boolean {
  return resolved.some((interaction) =>
    AFFIRMATIVE_RESOLUTION_STATUSES.has(interaction.status),
  );
}

/**
 * At least one accepted confirmation whose recorded outcome agrees. An
 * `accepted` row whose result says something else (e.g. a superseded/expired
 * outcome left on the row) is not a receipt.
 */
export function hasAcceptedCloseReceipt(
  resolved: SettlementInteraction[],
): boolean {
  return resolved.some((interaction) => {
    if (interaction.status !== SETTLEMENT_CLOSE_RECEIPT_STATUS) return false;
    const outcome = readRecordedOutcome(interaction);
    return outcome === null || outcome === SETTLEMENT_CLOSE_RECEIPT_STATUS;
  });
}

/**
 * Provenance stamped on the wake this sweep triggers, so a reader can tell
 * "blocker settled unexecuted" from "blocker completed" (`blocker_done`, the
 * human PATCH path). The auto-unblock arm otherwise carries no mutation at all.
 */
export const SETTLED_UNEXECUTED_MUTATION = "blocker_settled_unexecuted";

export const DECISION_INTERACTION_KINDS = [
  "ask_user_questions",
  "request_confirmation",
  "request_checkbox_confirmation",
  "request_item_verdicts",
] as const;

export type DecisionInteractionKind =
  (typeof DECISION_INTERACTION_KINDS)[number];

const DECISION_KIND_SET = new Set<string>(DECISION_INTERACTION_KINDS);

/** True only when payload?.requiresManualAction === true. Never truthy-check. */
export function readRequiresManualAction(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  return (
    (payload as { requiresManualAction?: unknown }).requiresManualAction ===
    true
  );
}

export interface SettlementInteraction {
  id: string;
  kind: string;
  status: string;
  payload: unknown;
  result?: unknown;
  createdByAgentId?: string | null;
  resolvedAt?: Date | string | null;
  updatedAt?: Date | string | null;
  createdAt?: Date | string | null;
}

export interface AwaitingYouSettlementDeps {
  issuesSvc: {
    update: (
      id: string,
      data: {
        assigneeAgentId?: string | null;
        assigneeUserId?: string | null;
        status?: string;
      },
    ) => Promise<unknown>;
    addComment: (
      issueId: string,
      body: string,
      actor: { agentId?: string | null; userId?: string | null },
      options?: { authorType?: string },
    ) => Promise<unknown>;
  };
  listInteractionsForIssue: (
    issueId: string,
  ) => Promise<SettlementInteraction[]>;
  enqueueWakeupFn: (
    agentId: string,
    opts: Record<string, unknown>,
  ) => Promise<unknown>;
  /** Production wires heartbeat.autoUnblockReadyDependents (same pattern, same gate). */
  unblockDependentsFn: (
    blockerIssueId: string,
    opts?: { mutation?: string },
  ) => Promise<unknown>;
  logFn?: (obj: Record<string, unknown>, msg: string) => void;
}

export interface AwaitingYouSettlementResult {
  scanned: number;
  handedBack: number;
  autoClosed: number;
  /** Cards deliberately left open: requiresManualAction plus receipt-less closes. Inclusive. */
  keptOpen: number;
  failed: number;
  issueIds: string[];
  /** SPA-11924: settled in principle, withheld from `done` for want of a work receipt. */
  unproven: number;
  unprovenIssueIds: string[];
}

function interactionTime(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/** Most-recently-resolved decision interaction, oldest timestamps last. */
function sortResolvedDesc(interactions: SettlementInteraction[]) {
  return [...interactions].sort((a, b) => {
    const at =
      interactionTime(a.resolvedAt) ||
      interactionTime(a.updatedAt) ||
      interactionTime(a.createdAt);
    const bt =
      interactionTime(b.resolvedAt) ||
      interactionTime(b.updatedAt) ||
      interactionTime(b.createdAt);
    return bt - at;
  });
}

function summarizeAnswer(interaction: SettlementInteraction): string {
  const payload =
    interaction.payload && typeof interaction.payload === "object"
      ? (interaction.payload as Record<string, unknown>)
      : null;
  const result =
    interaction.result && typeof interaction.result === "object"
      ? (interaction.result as Record<string, unknown>)
      : null;
  const title =
    (typeof payload?.["title"] === "string" && payload["title"]) ||
    (typeof payload?.["prompt"] === "string" && payload["prompt"]) ||
    interaction.kind;
  if (interaction.kind === "ask_user_questions") {
    const questions = Array.isArray(payload?.["questions"])
      ? (payload["questions"] as Array<Record<string, unknown>>)
      : [];
    const answers = Array.isArray(result?.["answers"])
      ? (result["answers"] as Array<Record<string, unknown>>)
      : [];
    const lines = questions.map((question) => {
      const answer = answers.find(
        (entry) => entry["questionId"] === question["id"],
      );
      const options = Array.isArray(question["options"])
        ? (question["options"] as Array<Record<string, unknown>>)
        : [];
      const picked = Array.isArray(answer?.["optionIds"])
        ? (answer["optionIds"] as unknown[])
            .map(
              (optionId) =>
                options.find((option) => option["id"] === optionId)?.["label"] ??
                String(optionId),
            )
            .join(", ")
        : null;
      const other =
        typeof answer?.["otherText"] === "string" && answer["otherText"]
          ? ` (other: ${answer["otherText"]})`
          : "";
      return `  - ${String(question["prompt"] ?? question["id"])} → ${picked ?? "(no selection)"}${other}`;
    });
    return `- ${interaction.kind} (${interaction.status}): ${title}\n${lines.join("\n")}`;
  }
  return `- ${interaction.kind} (${interaction.status}): ${title}`;
}

function buildResolutionComment(
  resolved: SettlementInteraction[],
  mode: "hand_back" | "auto_close",
): string {
  const header =
    mode === "hand_back"
      ? "Settlement: every decision request on this card is resolved. Handing the card back to its filing agent."
      : "Settlement: every decision request on this card is resolved and no live filing agent remains. Auto-closing the card.";
  return `${header}\n${resolved.map(summarizeAnswer).join("\n")}`;
}

/**
 * Done-gate refusal shape (issue-done-gate.ts refusalError): 409 whose message
 * starts "Issue cannot be marked done". Detected structurally so this module
 * stays free of the done-gate import graph. Never set doneGateBypass/Override.
 */
function isDoneGateRefusal(err: unknown): boolean {
  if (!(err instanceof HttpError) || err.status !== 409) return false;
  const details = err.details as { code?: unknown } | undefined;
  if (
    details?.code === "issue_done_with_unmerged_pull_request" ||
    details?.code === "issue_done_with_incomplete_execution_stage"
  ) {
    return true;
  }
  return (
    typeof err.message === "string" &&
    err.message.startsWith("Issue cannot be marked done")
  );
}

export async function settleSettledAwaitingYouIssues(
  db: Db,
  deps: AwaitingYouSettlementDeps,
  opts: { limit?: number } = {},
): Promise<AwaitingYouSettlementResult> {
  const limit = opts.limit ?? 50;
  const log = deps.logFn ?? (() => undefined);
  const result: AwaitingYouSettlementResult = {
    scanned: 0,
    handedBack: 0,
    autoClosed: 0,
    keptOpen: 0,
    failed: 0,
    issueIds: [],
    unproven: 0,
    unprovenIssueIds: [],
  };

  const candidates = await db
    .select()
    .from(issues)
    .where(
      and(
        notInArray(issues.status, ["done", "cancelled", "backlog"]),
        isNull(issues.assigneeAgentId),
        isNotNull(issues.assigneeUserId),
      ),
    )
    .orderBy(asc(issues.updatedAt))
    .limit(limit);
  result.scanned = candidates.length;

  for (const issue of candidates) {
    try {
      const all = await deps.listInteractionsForIssue(issue.id);
      const decision = all.filter((interaction) =>
        DECISION_KIND_SET.has(interaction.kind),
      );
      const pending = decision.filter(
        (interaction) => interaction.status === "pending",
      );
      const resolved = decision.filter(
        (interaction) => interaction.status !== "pending",
      );
      // Fully answered means at least one AFFIRMATIVE decision interaction and
      // zero still-pending ones. Non-decision kinds (suggest_tasks,
      // connection_intent) never block.
      //
      // SPA-11924: the old test was `status !== "pending"`, which also counted
      // expired / cancelled / withdrawn as answers. Those are administrative —
      // nobody ever decided — so a card whose only outcomes are administrative
      // must not settle, and must keep its human owner.
      if (resolved.length === 0 || pending.length > 0) continue;
      if (!hasAffirmativeResolution(resolved)) continue;

      // Keep-open: ANY decision payload (pending or resolved) demanding a
      // manual action keeps the card with its human owner.
      if (decision.some((interaction) => readRequiresManualAction(interaction.payload))) {
        result.keptOpen += 1;
        continue;
      }

      const ordered = sortResolvedDesc(resolved);
      const filerId =
        ordered[0]?.createdByAgentId ?? issue.createdByAgentId ?? null;
      let liveFilerId: string | null = null;
      if (filerId) {
        const [filer] = await db
          .select({
            id: agents.id,
            companyId: agents.companyId,
            status: agents.status,
          })
          .from(agents)
          .where(eq(agents.id, filerId))
          .limit(1);
        if (
          filer &&
          filer.companyId === issue.companyId &&
          // SPA-11924: the old literal equality test against the agent status
          // "active" was dead code — "active" is declared in AGENT_STATUSES but
          // no write path ever stores it on an agent, so liveFilerId was always
          // null and every answered user-owned card was auto-closed. Invokable
          // is the correct predicate: idle/running agents can be woken. `paused`
          // is deliberately excluded (it is assignable but not invokable) —
          // handing a card to a paused agent while clearing the human owner
          // would strand it with nobody.
          isAgentStatusInvokable(filer.status)
        ) {
          liveFilerId = filer.id;
        }
      }

      if (liveFilerId) {
        await deps.issuesSvc.addComment(
          issue.id,
          buildResolutionComment(ordered, "hand_back"),
          {},
          { authorType: "system" },
        );
        await deps.issuesSvc.update(issue.id, {
          assigneeAgentId: liveFilerId,
          assigneeUserId: null,
        });
        await queueIssueAssignmentWakeup({
          heartbeat: {
            wakeup: (agentId, wakeOpts) =>
              deps.enqueueWakeupFn(agentId, wakeOpts as Record<string, unknown>),
          },
          issue: { id: issue.id, assigneeAgentId: liveFilerId, status: issue.status },
          reason: "issue_assigned",
          mutation: "awaiting_you.settled_hand_back",
          contextSource: "awaiting_you_settlement",
          requestedByActorType: "system",
        });
        result.handedBack += 1;
        result.issueIds.push(issue.id);
        continue;
      }

      // SPA-11924: no work receipt, no `done`. Settling releases the human
      // owner, but it is not evidence the requested work happened, and the
      // done-gate cannot catch this class — these cards have no bound PR and a
      // null executionPolicy, so `issue_done_with_unmerged_pull_request` and
      // `issue_done_with_incomplete_execution_stage` are both inert for them.
      //
      // Deliberately no card comment: this card stays a sweep candidate, so a
      // comment per sweep would grow the thread without bound. Count + log is
      // the receipt. Dependents are also NOT released — a blocker that was
      // never resolved must not unblock the chain behind it.
      if (!hasAcceptedCloseReceipt(ordered)) {
        result.keptOpen += 1;
        result.unproven += 1;
        result.unprovenIssueIds.push(issue.id);
        log(
          { issueId: issue.id, reason: "awaiting_you_settlement_no_work_receipt" },
          "awaiting-you settlement withheld auto-close: no accepted work receipt",
        );
        continue;
      }

      await deps.issuesSvc.addComment(
        issue.id,
        buildResolutionComment(ordered, "auto_close"),
        {},
        { authorType: "system" },
      );
      try {
        // Normal close path: the done gate still applies. Never bypass it.
        await deps.issuesSvc.update(issue.id, { status: "done" });
      } catch (err) {
        if (isDoneGateRefusal(err)) {
          // A late hand-back is possible when the filer turned live between
          // reads; otherwise the card stays open for a human to close.
          const [retryFiler] = filerId
            ? await db
                .select({
                  id: agents.id,
                  companyId: agents.companyId,
                  status: agents.status,
                })
                .from(agents)
                .where(eq(agents.id, filerId))
                .limit(1)
            : [null];
          if (
            retryFiler &&
            retryFiler.companyId === issue.companyId &&
            // Same invokable predicate as the primary read (SPA-11924).
            isAgentStatusInvokable(retryFiler.status)
          ) {
            await deps.issuesSvc.update(issue.id, {
              assigneeAgentId: retryFiler.id,
              assigneeUserId: null,
            });
            await queueIssueAssignmentWakeup({
              heartbeat: {
                wakeup: (agentId, wakeOpts) =>
                  deps.enqueueWakeupFn(
                    agentId,
                    wakeOpts as Record<string, unknown>,
                  ),
              },
              issue: {
                id: issue.id,
                assigneeAgentId: retryFiler.id,
                status: issue.status,
              },
              reason: "issue_assigned",
              mutation: "awaiting_you.settled_hand_back",
              contextSource: "awaiting_you_settlement",
              requestedByActorType: "system",
            });
            result.handedBack += 1;
            result.issueIds.push(issue.id);
            continue;
          }
        }
        throw err;
      }
      await deps.unblockDependentsFn(issue.id, {
        mutation: SETTLED_UNEXECUTED_MUTATION,
      });
      result.autoClosed += 1;
      result.issueIds.push(issue.id);
    } catch (err) {
      result.failed += 1;
      log({ err, issueId: issue.id }, "awaiting-you settlement failed for issue");
    }
  }

  return result;
}
