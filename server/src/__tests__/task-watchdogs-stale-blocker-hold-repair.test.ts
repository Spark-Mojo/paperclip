import { describe, expect, it } from "vitest";
import {
  TASK_WATCHDOG_IMMUTABLE_REPAIR_LEAF_FIELDS,
  TASK_WATCHDOG_REPAIR_MUTABLE_LEAF_FIELD,
  classifyTaskWatchdogMutationAdmissibility,
  classifyTaskWatchdogSubtree,
  type TaskWatchdogClassifierIssue,
  type TaskWatchdogStopSnapshot,
} from "../services/task-watchdogs.ts";

const companyId = "company-1";
const sourceId = "source-1";
const leafId = "leaf-1";
const blockerId = "blocker-1";
const siblingIdDefault = "sibling-1";

function issue(overrides: Partial<TaskWatchdogClassifierIssue> = {}): TaskWatchdogClassifierIssue {
  return {
    id: sourceId,
    companyId,
    identifier: "PAP-1",
    title: "Source",
    status: "todo",
    parentId: null,
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    originKind: "manual",
    updatedAt: new Date("2026-09-15T12:22:00.000Z"),
    createdAt: new Date("2026-09-15T11:00:00.000Z"),
    ...overrides,
  };
}

// The SPA-7407 shape: a blocked leaf whose sole blocker is done, and nothing in
// the subtree is live or waiting.
function staleHoldClassification(overrides: {
  leafStatus?: string;
  blockerStatus?: string;
  blockersPresent?: boolean;
  siblingId?: string | null;
} = {}) {
  const siblingId = overrides.siblingId === undefined ? siblingIdDefault : overrides.siblingId;
  return classifyTaskWatchdogSubtree({
    watchdog: { companyId, issueId: sourceId, lastReviewedFingerprint: null },
    issues: [
      issue(),
      issue({
        id: leafId,
        identifier: "PAP-2",
        parentId: sourceId,
        status: overrides.leafStatus ?? "blocked",
        assigneeAgentId: null,
        assigneeUserId: "user-1",
      }),
      ...(siblingId
        ? [issue({
            id: siblingId,
            identifier: "PAP-3",
            parentId: sourceId,
            status: "in_review",
          })]
        : []),
    ],
    blockers: overrides.blockersPresent === false
      ? []
      : [{ companyId, blockerIssueId: blockerId, blockedIssueId: leafId, blockerStatus: overrides.blockerStatus ?? "done" }],
  });
}

describe("task watchdog stale blocker hold (SPA-7407)", () => {
  it("keeps the repair immutability list in step with the material fingerprint fields", () => {
    // The carve-out derives its immutability check from this list. If someone
    // adds a field to TaskWatchdogMaterialLeaf without adding it here, a change
    // to that field would read as "only status changed" and silently widen the
    // carve-out. This assertion is what makes that drift impossible.
    const covered = new Set<string>([
      ...TASK_WATCHDOG_IMMUTABLE_REPAIR_LEAF_FIELDS,
      TASK_WATCHDOG_REPAIR_MUTABLE_LEAF_FIELD,
    ]);
    const runtime = classifyTaskWatchdogSubtree({
      watchdog: { companyId, issueId: sourceId, lastReviewedFingerprint: null },
      issues: [issue({ status: "in_review" })],
    });
    if (runtime.state !== "stopped") throw new Error("expected stopped");
    // `stoppedLeaves` carries exactly the material-leaf fields at runtime; the
    // structural type keeps them in step, so assert the two lists partition it.
    const materialFields = Object.keys(runtime.stopSnapshot.materialLeaves[0] ?? {}).sort();
    expect(materialFields).toEqual([...covered].sort());
  });

  it("classifies a stale blocker hold as stopped so the watchdog can review it", () => {
    const resolved = staleHoldClassification();
    expect(resolved.state).toBe("stopped");
    expect(resolved.staleBlockerHolds).toEqual([
      { issueId: leafId, identifier: "PAP-2", staleBlockerIssueIds: [blockerId] },
    ]);

    // NEGATIVE control for the same assertion: with the blocker still live the
    // hold must not be reported, and the subtree must not be treated as a
    // stoppable hold at all.
    const unresolved = staleHoldClassification({ blockerStatus: "in_progress" });
    expect(unresolved.staleBlockerHolds).toEqual([]);
  });

  it("does not report a hold for a blocked leaf with no recorded blocker edge", () => {
    const result = staleHoldClassification({ blockersPresent: false });
    expect(result.staleBlockerHolds).toEqual([]);
  });

  it("admits the blocked -> todo repair of a resolved stale blocker hold", () => {
    const reviewed = staleHoldClassification();
    expect(reviewed.state).toBe("stopped");
    if (reviewed.state !== "stopped") return;
    const reviewedSnapshot: TaskWatchdogStopSnapshot = reviewed.stopSnapshot;

    // The repair: the hold leaf leaves `blocked`, so `status` — which is part of
    // the material fingerprint — necessarily changes.
    const afterRepair = staleHoldClassification({ leafStatus: "todo" });
    expect(afterRepair.stopFingerprint).not.toBe(reviewed.stopFingerprint);

    const verdict = classifyTaskWatchdogMutationAdmissibility({
      current: afterRepair,
      reviewedStopFingerprint: reviewed.stopFingerprint,
      reviewedStopSnapshot: reviewedSnapshot,
    });
    expect(verdict).toEqual({
      admissible: true,
      reason: "stale_blocker_hold_repair",
      staleBlockerHoldIssueIds: [leafId],
      // The carve-out authorises exactly one edge: release the hold to `todo`.
      // `done` and `cancelled` are NOT authorized — a stall diagnosis is not a
      // completion diagnosis.
      allowedStatusTransitions: [{ issueId: leafId, from: "blocked", to: "todo" }],
    });
  });

  it("refuses a mutation when the revalidation diverges for any other reason", () => {
    const reviewed = staleHoldClassification();
    if (reviewed.state !== "stopped") throw new Error("expected stopped");
    const reviewedSnapshot = reviewed.stopSnapshot;

    // Same hold, same leaf-status-only change, but a SIBLING LEAF's assignee
    // changed too. That is a different stop, not a repair of this one — and the
    // sibling is what makes it a real divergence, since a non-leaf issue's own
    // status is deliberately outside the material fingerprint.
    const siblingDiverged = classifyTaskWatchdogSubtree({
      watchdog: { companyId, issueId: sourceId, lastReviewedFingerprint: null },
      issues: [
        issue(),
        issue({
          id: leafId,
          identifier: "PAP-2",
          parentId: sourceId,
          status: "todo",
          assigneeAgentId: null,
          assigneeUserId: "user-1",
        }),
        issue({
          id: siblingIdDefault,
          identifier: "PAP-3",
          parentId: sourceId,
          status: "in_review",
          assigneeAgentId: "agent-2",
        }),
      ],
      blockers: [{ companyId, blockerIssueId: blockerId, blockedIssueId: leafId, blockerStatus: "done" }],
    });
    expect(siblingDiverged.stopFingerprint).not.toBe(reviewed.stopFingerprint);
    expect(
      classifyTaskWatchdogMutationAdmissibility({
        current: siblingDiverged,
        reviewedStopFingerprint: reviewed.stopFingerprint,
        reviewedStopSnapshot: reviewedSnapshot,
      }),
    ).toMatchObject({ admissible: false, reason: "changed_fingerprint" });

    // An identical subtree is admitted by fingerprint, never by the carve-out.
    expect(
      classifyTaskWatchdogMutationAdmissibility({
        current: staleHoldClassification(),
        reviewedStopFingerprint: reviewed.stopFingerprint,
        reviewedStopSnapshot: reviewedSnapshot,
      }),
    ).toMatchObject({ admissible: true, reason: "fingerprint_match" });

    // A live path in the subtree is never a repair, even when the reviewed
    // snapshot is missing.
    const live = classifyTaskWatchdogSubtree({
      watchdog: { companyId, issueId: sourceId, lastReviewedFingerprint: null },
      issues: [
        issue({ status: "in_progress" }),
        issue({ id: leafId, identifier: "PAP-2", parentId: sourceId, status: "todo" }),
      ],
      activeRuns: [{ companyId, issueId: leafId, agentId: "agent-1", status: "running" }],
    });
    expect(live.state).toBe("live");
    expect(
      classifyTaskWatchdogMutationAdmissibility({
        current: live,
        reviewedStopFingerprint: reviewed.stopFingerprint,
        reviewedStopSnapshot: null,
      }),
    ).toMatchObject({ admissible: false, reason: "reclassified_not_stopped" });
  });

  it("fails closed when the run carries no wake snapshot to compare against", () => {
    const reviewed = staleHoldClassification();
    if (reviewed.state !== "stopped") throw new Error("expected stopped");
    const afterRepair = staleHoldClassification({ leafStatus: "todo" });
    if (afterRepair.state !== "stopped") throw new Error("expected stopped");

    // A run whose wake context could not be read has no baseline, so even a
    // genuine repair is refused rather than admitted against nothing.
    expect(
      classifyTaskWatchdogMutationAdmissibility({
        current: afterRepair,
        reviewedStopFingerprint: reviewed.stopFingerprint,
        reviewedStopSnapshot: null,
      }),
    ).toMatchObject({ admissible: false, allowedStatusTransitions: [] });

    // A snapshot that does not parse is treated the same way.
    expect(
      classifyTaskWatchdogMutationAdmissibility({
        current: afterRepair,
        reviewedStopFingerprint: reviewed.stopFingerprint,
        reviewedStopSnapshot: { version: 1 } as never,
      }),
    ).toMatchObject({ admissible: false, allowedStatusTransitions: [] });
  });
});
