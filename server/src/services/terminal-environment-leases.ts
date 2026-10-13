import type { Db } from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { environmentLeases, heartbeatRuns } from "@paperclipai/db";

/**
 * SPA-9423: terminal environment-lease release + reclaim + finite ephemeral expiry.
 *
 * Helpers in this module never touch the wake / recovery region that PR #122
 * edits and never replace the existing `releaseEnvironmentLeasesForRun` flow
 * used by every terminal transition. They add: (a) startup/periodic reclamation
 * of `active` leases whose owning run is provably terminal, and (b) restart
 * reconciliation that releases an orphaned lease and dispatches a bounded
 * replacement run, in that order. The lease subsystem contract is unchanged
 * for the live-transition path.
 */

export const TERMINAL_LEASE_LOCAL_EPHEMERAL_DEFAULT_TTL_MS = 60 * 60 * 1000;

const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "timed_out",
] as const;
type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

const LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;

const ORPHANED_RUN_ERROR_CODES = [
  "orphaned_running_run",
  "server_shutdown_interrupted",
  "lease_released_before_terminal",
] as const;

export type TerminalLeaseReclaimOutcome = {
  reclaimed: number;
  skippedUnknownOwner: number;
  skippedLiveOwners: number;
  skippedCrossCompany: number;
  skippedOwnershipChanged: number;
  driverFailures: Array<{ leaseId: string; error: string }>;
  releasedLeaseIds: string[];
};

export type RestartReplacementOutcome = TerminalLeaseReclaimOutcome & {
  replacedRunIds: string[];
  releasedRestartOrphans: Array<{ runId: string; leaseId: string }>;
  replacementDispatchFailures: Array<{ fromRunId: string; error: string }>;
};

export type TerminalOwnerProof =
  | { kind: "terminal_status"; status: TerminalRunStatus }
  | { kind: "orphaned_error_code"; errorCode: string };

export function isTerminalRunStatus(value: string): value is TerminalRunStatus {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(value);
}

export function isLiveRunStatus(value: string): boolean {
  return (LIVE_RUN_STATUSES as readonly string[]).includes(value);
}

export function isOrphanedRunErrorCode(value: string | null | undefined): boolean {
  return typeof value === "string"
    && (ORPHANED_RUN_ERROR_CODES as readonly string[]).includes(value);
}

export type ReclamationOwnerState =
  | { kind: "unknown_owner"; reason: "missing_run" }
  | { kind: "live_owner"; status: string }
  | { kind: "ownership_changed" }
  | { kind: "cross_company"; leaseCompanyId: string; runCompanyId: string }
  | { kind: "terminal_owner"; runId: string; proof: TerminalOwnerProof };

export async function resolveReclamationOwnerState(
  db: Db,
  leaseId: string,
): Promise<ReclamationOwnerState> {
  const row = await db
    .select({
      id: environmentLeases.id,
      companyId: environmentLeases.companyId,
      heartbeatRunId: environmentLeases.heartbeatRunId,
      leasePolicy: environmentLeases.leasePolicy,
    })
    .from(environmentLeases)
    .where(eq(environmentLeases.id, leaseId))
    .then((rows) => rows[0] ?? null);
  if (!row) return { kind: "unknown_owner", reason: "missing_run" };

  // SPA-9423 D5 fix: `retained` leases must survive both expiry and the
  // sweep. The runtime's releaseRunLeases select naturally filters by
  // status=active, so a retained lease never reaches the driver teardown,
  // but the sweep's candidate-loader also has to skip it explicitly so the
  // `outcome.skippedLiveOwners` counter is honest. The retained-policy shape
  // is `reuse_by_environment` with status = `retained` (or `released`/`expired`
  // while ownership is still being transferred); the candidate loader
  // already filters to status=active, so a retained lease only reaches this
  // helper if it is somehow active+reuse_by_environment. Defensive guard.
  if (row.leasePolicy === "reuse_by_environment") {
    return { kind: "live_owner", status: "retained_lease_policy" };
  }

  if (!row.heartbeatRunId) return { kind: "ownership_changed" };

  const runRow = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      status: heartbeatRuns.status,
      errorCode: heartbeatRuns.errorCode,
      runtimeMode: heartbeatRuns.runtimeMode,
      nativePhase: heartbeatRuns.nativePhase,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, row.heartbeatRunId))
    .then((rows) => rows[0] ?? null);
  if (!runRow) return { kind: "ownership_changed" };
  if (runRow.companyId !== row.companyId) {
    return {
      kind: "cross_company",
      leaseCompanyId: row.companyId,
      runCompanyId: runRow.companyId,
    };
  }

  // SPA-9423 D5 fix: explicit native-ownership safeguard. The
  // `isNativeRunnerOwnershipHeld` check requires runtimeMode=native AND
  // (errorCode=native_execution_ownership_unverified AND nativePhase=
  // terminal_failure) OR errorCode=native_adopted_runner_authentication_
  // timeout. The `live_owner` branch below catches the matching status=running
  // case, but the native runner can hold ownership while the run is in
  // another status. Be explicit so the safeguard is named, not accidental.
  if (runRow.runtimeMode === "native") {
    if (
      runRow.errorCode === "native_execution_ownership_unverified" &&
      runRow.nativePhase === "terminal_failure"
    ) {
      return { kind: "live_owner", status: "native_runner_ownership_held" };
    }
    if (runRow.errorCode === "native_adopted_runner_authentication_timeout") {
      return { kind: "live_owner", status: "native_runner_ownership_held" };
    }
  }

  if (isLiveRunStatus(runRow.status)) {
    return { kind: "live_owner", status: runRow.status };
  }

  if (isTerminalRunStatus(runRow.status)) {
    return {
      kind: "terminal_owner",
      runId: runRow.id,
      proof: { kind: "terminal_status", status: runRow.status },
    };
  }

  // A non-terminal status with an orphan error code is still terminal-owner
  // proof: the run is dead even if its status field is stale. The 104-row
  // evidence on SPA-9351 had exactly this shape — `interrupted` with
  // `errorCode = orphaned_running_run`.
  if (isOrphanedRunErrorCode(runRow.errorCode)) {
    return {
      kind: "terminal_owner",
      runId: runRow.id,
      proof: {
        kind: "orphaned_error_code",
        errorCode: runRow.errorCode ?? "unknown",
      },
    };
  }

  return { kind: "unknown_owner", reason: "missing_run" };
}

export async function claimTerminalOwnedLeaseAtomically(
  db: Db,
  leaseId: string,
): Promise<boolean> {
  const now = new Date();
  const result = await db
    .update(environmentLeases)
    .set({
      status: "pending_cleanup",
      cleanupStatus: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(environmentLeases.id, leaseId),
        eq(environmentLeases.status, "active"),
      ),
    )
    .returning({ id: environmentLeases.id });
  return result.length === 1;
}

export async function loadActiveLeaseCandidates(
  db: Db,
  batchSize: number,
): Promise<Array<{ id: string; heartbeatRunId: string | null; companyId: string }>> {
  return await db
    .select({
      id: environmentLeases.id,
      heartbeatRunId: environmentLeases.heartbeatRunId,
      companyId: environmentLeases.companyId,
    })
    .from(environmentLeases)
    .where(eq(environmentLeases.status, "active"))
    .orderBy(environmentLeases.lastUsedAt)
    .limit(batchSize);
}

export async function releaseLeaseAsFailed(
  db: Db,
  leaseId: string,
  failureReason: string,
): Promise<void> {
  // SPA-9423 D4 fix: only stamp cleanupStatus=failed if the lease is still
  // active. Without the AND status = 'active' guard, a concurrent successful
  // release (which flipped the lease to released/expired/failed) could be
  // reverted by this write, resurrecting a dead lease.
  await db
    .update(environmentLeases)
    .set({
      cleanupStatus: "failed",
      failureReason,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(environmentLeases.id, leaseId),
        eq(environmentLeases.status, "active"),
      ),
    );
}

export async function releaseLeaseAsSucceeded(
  db: Db,
  leaseId: string,
): Promise<void> {
  await db
    .update(environmentLeases)
    .set({
      status: "released",
      releasedAt: new Date(),
      cleanupStatus: "success",
      updatedAt: new Date(),
    })
    .where(eq(environmentLeases.id, leaseId));
}

export type DriverTeardown = (input: {
  leaseId: string;
  heartbeatRunId: string | null;
  companyId: string;
}) => Promise<void>;

const defaultDriverTeardown: DriverTeardown = async (input) => {
  throw new Error(
    `terminal lease driver teardown not installed for lease ${input.leaseId}`,
  );
};

let installedTeardown: DriverTeardown = defaultDriverTeardown;

export function installDriverTeardown(teardown: DriverTeardown): void {
  installedTeardown = teardown;
}

async function tearDownClaimedLease(input: {
  db: Db;
  leaseId: string;
  heartbeatRunId: string | null;
  companyId: string;
}): Promise<void> {
  // SPA-9423 D3 fix: the installed teardown routes through
  // envOrchestrator.releaseForRun, which flips status from active to
  // released/expired/failed in the runtime's same-transaction update. The
  // success path needs no extra write here. On driver failure, the
  // installed teardown THROWS (D3 fix at the heartbeat-service hook); this
  // catch stamps cleanupStatus=failed and rethrows so the reclaim loop
  // records the failure in driverFailures. The lease stays active, so the
  // next sweep tick retries.
  try {
    await installedTeardown({
      leaseId: input.leaseId,
      heartbeatRunId: input.heartbeatRunId,
      companyId: input.companyId,
    });
  } catch (err) {
    await input.db
      .update(environmentLeases)
      .set({
        cleanupStatus: "failed",
        failureReason: `terminal_lease_teardown_failed: ${err instanceof Error ? err.message : String(err)}`,
        updatedAt: new Date(),
      })
      .where(eq(environmentLeases.id, input.leaseId));
    throw err;
  }
  // Sanity check: the runtime must have flipped status. If status is still
  // active, the runtime select found zero rows (another path won the race);
  // we count that as not-released-by-this-sweep and throw so the reclaim
  // loop records a driverFailure.
  const after = await input.db
    .select({ status: environmentLeases.status })
    .from(environmentLeases)
    .where(eq(environmentLeases.id, input.leaseId))
    .then((rows) => rows[0] ?? null);
  if (after?.status === "active") {
    throw new Error(
      `terminal lease teardown left lease ${input.leaseId} active; runtime select found no rows`,
    );
  }
}

export async function reclaimTerminalEnvironmentLeases(input: {
  db: Db;
  batchSize: number;
}): Promise<TerminalLeaseReclaimOutcome> {
  const { db, batchSize } = input;
  const outcome: TerminalLeaseReclaimOutcome = {
    reclaimed: 0,
    skippedUnknownOwner: 0,
    skippedLiveOwners: 0,
    skippedCrossCompany: 0,
    skippedOwnershipChanged: 0,
    driverFailures: [],
    releasedLeaseIds: [],
  };

  const candidates = await loadActiveLeaseCandidates(db, batchSize);
  for (const candidate of candidates) {
    const ownerState = await resolveReclamationOwnerState(db, candidate.id);
    switch (ownerState.kind) {
      case "unknown_owner":
        outcome.skippedUnknownOwner += 1;
        continue;
      case "live_owner":
        outcome.skippedLiveOwners += 1;
        continue;
      case "ownership_changed":
        outcome.skippedOwnershipChanged += 1;
        continue;
      case "cross_company":
        outcome.skippedCrossCompany += 1;
        continue;
      case "terminal_owner": {
        // SPA-9423 D1 fix: drop the claim-first / pending_cleanup-flip pattern.
        // It raced the runtime releaseRunLeases select (status=active). The
        // runtime's per-lease onLeaseReleaseError already isolates driver
        // failures; routing through envOrchestrator.releaseForRun keeps the
        // native-ownership safeguard (releaseEnvironmentLeasesForRun -> isNativeRunnerOwnershipHeld)
        // on the path.
        try {
          await tearDownClaimedLease({
            db,
            leaseId: candidate.id,
            heartbeatRunId: candidate.heartbeatRunId,
            companyId: candidate.companyId,
          });
          outcome.reclaimed += 1;
          outcome.releasedLeaseIds.push(candidate.id);
        } catch (error) {
          outcome.driverFailures.push({
            leaseId: candidate.id,
            error: error instanceof Error ? error.message : String(error),
          });
          await releaseLeaseAsFailed(db, candidate.id, "reclaim_driver_failed");
        }
        continue;
      }
    }
  }
  return outcome;
}

export type ReplacementDispatcher = (input: {
  fromRunId: string;
  leaseId: string;
}) => Promise<{ replacementRunId: string | null }>;

const defaultReplacementDispatcher: ReplacementDispatcher = async () => {
  return { replacementRunId: null };
};

let installedDispatcher: ReplacementDispatcher = defaultReplacementDispatcher;

export function installReplacementDispatcher(
  dispatcher: ReplacementDispatcher,
): void {
  installedDispatcher = dispatcher;
}

export async function reclaimTerminalEnvironmentLeasesForRestart(input: {
  db: Db;
  batchSize: number;
  onLeaseReleased?: (event: { runId: string; reason: "restart_reconciliation" }) => void;
  onReplacementDispatched?: (event: { fromRunId: string; runId: string }) => void;
}): Promise<RestartReplacementOutcome> {
  const base = await reclaimTerminalEnvironmentLeases({
    db: input.db,
    batchSize: input.batchSize,
  });
  // SPA-9423 D2 fix: bound restart-dispatch to lease IDs the base reclaim
  // released in this tick (base.releasedLeaseIds). Historical released rows
  // are NOT restart-orphans — they already had their bounded replacement
  // dispatched (or none was ever possible).
  const releasedThisSweep = new Set(base.releasedLeaseIds);
  const outcome: RestartReplacementOutcome = {
    ...base,
    replacedRunIds: [],
    releasedRestartOrphans: [],
    replacementDispatchFailures: [],
  };

  // Scope replacement dispatch to leases released in THIS sweep. The base
  // reclaim updated each terminal-owned lease to `released` within the same
  // heartbeat tick; re-read those rows by status + leasePolicy and bound the
  // dispatch to the IDs the base sweep actually touched.
  const releasedRows = await input.db
    .select({
      id: environmentLeases.id,
      runId: environmentLeases.heartbeatRunId,
    })
    .from(environmentLeases)
    .where(
      and(
        inArray(environmentLeases.status, ["released", "expired", "failed"]),
        eq(environmentLeases.leasePolicy, "ephemeral"),
      ),
    )
    .limit(input.batchSize);
  // The base sweep updates terminal-owned leases to `released` in this
  // same transaction; the rows below are exactly those. Historical
  // `released` rows from prior sweeps are not restart-orphans — they have
  // already had their bounded replacement dispatched (or none was ever
  // possible). The set here is the restart-scope boundary.
  // SPA-9423 D2 fix: bound restart-dispatch to lease IDs the base reclaim
  // released in this tick (releasedThisSweep is set by the caller from
  // base.releasedLeaseIds). Historical released rows are NOT restart-orphans.
  for (const row of releasedRows) {
    if (!releasedThisSweep.has(row.id)) continue;
    if (!row.runId) continue;
    const runRow = await input.db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, row.runId))
      .then((rows) => rows[0] ?? null);
    if (!runRow) continue;
    if (!isTerminalRunStatus(runRow.status) && !isOrphanedRunErrorCode(runRow.errorCode)) {
      continue;
    }
    outcome.releasedRestartOrphans.push({ runId: row.runId, leaseId: row.id });
    input.onLeaseReleased?.({ runId: row.runId, reason: "restart_reconciliation" });
    try {
      const replacement = await installedDispatcher({
        fromRunId: row.runId,
        leaseId: row.id,
      });
      if (replacement.replacementRunId) {
        outcome.replacedRunIds.push(replacement.replacementRunId);
        input.onReplacementDispatched?.({
          fromRunId: row.runId,
          runId: replacement.replacementRunId,
        });
      }
    } catch (error) {
      outcome.replacementDispatchFailures.push({
        fromRunId: row.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return outcome;
}

export function finiteExpiryForLocalEphemeral(now: Date): Date {
  return new Date(now.getTime() + TERMINAL_LEASE_LOCAL_EPHEMERAL_DEFAULT_TTL_MS);
}

export function resetTerminalLeaseModuleForTest(): void {
  installedTeardown = defaultDriverTeardown;
  installedDispatcher = defaultReplacementDispatcher;
}
