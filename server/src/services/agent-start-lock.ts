import { AsyncLocalStorage } from "node:async_hooks";

import { logger } from "../middleware/logger.js";

const AGENT_START_LOCK_STALE_MS = 30_000;
const startLocksByAgent = new Map<string, { promise: Promise<void>; startedAtMs: number }>();

async function waitForAgentStartLock(agentId: string, lock: { promise: Promise<void>; startedAtMs: number }) {
  const elapsedMs = Date.now() - lock.startedAtMs;
  const remainingMs = AGENT_START_LOCK_STALE_MS - elapsedMs;
  if (remainingMs <= 0) {
    logger.warn({ agentId, staleMs: elapsedMs }, "agent start lock stale; continuing queued-run start");
    return;
  }

  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    lock.promise,
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve();
      }, remainingMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (timedOut) {
    logger.warn({ agentId, staleMs: AGENT_START_LOCK_STALE_MS }, "agent start lock timed out; continuing queued-run start");
  }
}

export async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
  const previous = startLocksByAgent.get(agentId);
  const waitForPrevious = previous ? waitForAgentStartLock(agentId, previous) : Promise.resolve();
  const run = waitForPrevious.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByAgent.set(agentId, { promise: marker, startedAtMs: Date.now() });
  try {
    return await run;
  } finally {
    if (startLocksByAgent.get(agentId)?.promise === marker) {
      startLocksByAgent.delete(agentId);
    }
  }
}

// ---------------------------------------------------------------------------
// Fleet-wide run admission lock (opt-in; see PAPERCLIP_MAX_CONCURRENT_AGENT_RUNS
// in heartbeat.ts). Ported from upstream paperclipai/paperclip#13621.
//
// The per-agent lock above only serialises one agent against itself, so two
// agents admitted in the same tick could each read the same free fleet slot and
// both claim it. This lock makes "count running runs -> claim queued runs"
// atomic across agents, which is what makes the fleet ceiling hard. It is only
// taken when a fleet ceiling is configured; with no ceiling, admission is not
// serialised across agents (today's behaviour).
// ---------------------------------------------------------------------------

const FLEET_ADMISSION_SLOW_WARN_MS = 30_000;

type FleetLock = { promise: Promise<void>; startedAtMs: number };

let fleetRunAdmissionLock: FleetLock | null = null;

// The admission critical section can call back into itself: claiming or
// releasing an issue execution applies post-commit wake effects, and a
// `run_queued` effect calls startNextQueuedRunForAgent again. Awaiting the
// lock's own in-flight marker from inside its holder would deadlock, so nested
// acquisitions on the same async context run inline (the outer hold already
// provides exclusivity). A module boolean cannot distinguish nested from
// concurrent callers; async context can.
const fleetRunAdmissionContext = new AsyncLocalStorage<true>();

/**
 * Wait for the current holder to finish. Unlike the per-agent stale guard, this
 * never releases the lock early: the fleet ceiling must stay exclusive until the
 * holder's "count running -> claim" finishes, otherwise two waiters can read the
 * same free slot and both claim it. The stored promise is the holder's settled
 * marker (resolves on success and on error), so a normal holder always releases
 * it; a long hold is logged for visibility but the waiter still waits.
 */
async function awaitFleetLockOwner(lock: FleetLock) {
  const heldMs = Date.now() - lock.startedAtMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const warnSlow = () =>
    logger.warn(
      { lockScope: "fleet-run-admission", heldMs: Date.now() - lock.startedAtMs },
      "fleet run admission lock held longer than expected; waiting for the holder to finish",
    );
  if (heldMs >= FLEET_ADMISSION_SLOW_WARN_MS) {
    warnSlow();
  } else {
    timer = setTimeout(warnSlow, FLEET_ADMISSION_SLOW_WARN_MS - heldMs);
    timer.unref?.();
  }
  try {
    await lock.promise;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function withFleetRunAdmissionLock<T>(fn: () => Promise<T>): Promise<T> {
  // Re-entrant call from inside the current critical section: the lock is
  // already held on this async context, so run inline.
  if (fleetRunAdmissionContext.getStore()) {
    return fn();
  }
  const previous = fleetRunAdmissionLock;
  const waitForPrevious = previous ? awaitFleetLockOwner(previous) : Promise.resolve();
  const run = waitForPrevious.then(() => fleetRunAdmissionContext.run(true, fn));
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  fleetRunAdmissionLock = { promise: marker, startedAtMs: Date.now() };
  try {
    return await run;
  } finally {
    if (fleetRunAdmissionLock?.promise === marker) {
      fleetRunAdmissionLock = null;
    }
  }
}

/** True while the caller runs inside a fleet admission critical section. */
export function isInsideFleetRunAdmission() {
  return fleetRunAdmissionContext.getStore() === true;
}

/**
 * Detach `fn` from the current fleet admission context.
 *
 * Reentrancy is only correct while the critical section that owns the lock is
 * still running. A fire-and-forget execution spawned from a lock holder must not
 * carry the marker past that section, or its later promotion would run admission
 * inline after the lock was released and let two count-and-claim windows
 * overlap. `exit` runs `fn` (and the async work it creates) without the marker.
 */
export function runOutsideFleetRunAdmission<T>(fn: () => T): T {
  return fleetRunAdmissionContext.exit(fn);
}
