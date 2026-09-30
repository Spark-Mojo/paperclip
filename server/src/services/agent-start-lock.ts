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
// A holder that never settles (for example a database call that hangs with no
// lock_timeout) must not freeze admission for the whole instance until a
// restart. After this long a waiter logs an error and proceeds. Because the
// admission path recounts the fleet budget before every claim, an overlap after
// a stale release risks a small over-admit, never a permanent stall.
export const FLEET_ADMISSION_STALE_MS = 120_000;

type FleetLock = { promise: Promise<void>; startedAtMs: number };

let fleetRunAdmissionLock: FleetLock | null = null;

// The admission critical section can call back into admission: claiming or
// cancelling a queued run applies post-commit wake effects, and a `run_queued`
// effect or a cancel's same-agent re-admit calls startNextQueuedRunForAgent
// again. Running that nested admission inline is wrong twice over: it claims
// fleet slots the outer budget never sees, and it waits on per-agent start
// locks while holding the fleet lock (a 30s self-wait for the same agent, a
// circular wait for another agent whose own admission is waiting on the fleet
// lock). So nested admissions are DEFERRED: the section's store collects the
// agent ids and the caller re-runs them after it has released every lock. The
// store is per outermost section, carried by async context; a module variable
// cannot tell a nested caller from a concurrent one.
type FleetAdmissionStore = { deferred: Set<string> };
const fleetRunAdmissionContext = new AsyncLocalStorage<FleetAdmissionStore>();

/**
 * Wait for the current holder to finish. The fleet ceiling must stay exclusive
 * until the holder's "count running -> claim" finishes, so a slow holder is
 * waited out (with a warning). Only a holder that has run past
 * FLEET_ADMISSION_STALE_MS is treated as hung: the waiter logs an error and
 * proceeds rather than stalling every agent forever.
 */
async function awaitFleetLockOwner(lock: FleetLock) {
  const heldMs = Date.now() - lock.startedAtMs;
  const remainingMs = FLEET_ADMISSION_STALE_MS - heldMs;
  if (remainingMs <= 0) {
    logger.error(
      { lockScope: "fleet-run-admission", heldMs },
      "fleet run admission lock stale; continuing admission",
    );
    return;
  }
  let warnTimer: ReturnType<typeof setTimeout> | null = null;
  let staleTimer: ReturnType<typeof setTimeout> | null = null;
  const warnSlow = () =>
    logger.warn(
      { lockScope: "fleet-run-admission", heldMs: Date.now() - lock.startedAtMs },
      "fleet run admission lock held longer than expected; waiting for the holder to finish",
    );
  if (heldMs >= FLEET_ADMISSION_SLOW_WARN_MS) {
    warnSlow();
  } else {
    warnTimer = setTimeout(warnSlow, FLEET_ADMISSION_SLOW_WARN_MS - heldMs);
    warnTimer.unref?.();
  }
  let timedOut = false;
  try {
    await Promise.race([
      lock.promise,
      new Promise<void>((resolve) => {
        staleTimer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, remainingMs);
        (staleTimer as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (warnTimer) clearTimeout(warnTimer);
    if (staleTimer) clearTimeout(staleTimer);
  }
  if (timedOut) {
    logger.error(
      { lockScope: "fleet-run-admission", staleMs: FLEET_ADMISSION_STALE_MS },
      "fleet run admission lock timed out; continuing admission",
    );
  }
}

/**
 * Run `fn` as the instance-wide admission critical section.
 *
 * `options.deferred` is the caller's collector for nested admissions requested
 * while `fn` runs (see deferFleetRunAdmission). The caller drains it after it
 * has released this lock and any per-agent lock it holds.
 */
export async function withFleetRunAdmissionLock<T>(
  fn: () => Promise<T>,
  options: { deferred?: Set<string> } = {},
): Promise<T> {
  // Defensive: a nested acquisition on the same async context is already
  // covered by the outer hold, so run inline instead of awaiting our own marker.
  if (fleetRunAdmissionContext.getStore()) {
    return fn();
  }
  const store: FleetAdmissionStore = { deferred: options.deferred ?? new Set() };
  const previous = fleetRunAdmissionLock;
  const waitForPrevious = previous ? awaitFleetLockOwner(previous) : Promise.resolve();
  const run = waitForPrevious.then(() => fleetRunAdmissionContext.run(store, fn));
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
  return fleetRunAdmissionContext.getStore() !== undefined;
}

/**
 * Inside a fleet admission critical section, record `key` (an agent id) for
 * admission after the section's owner releases its locks, and return true.
 * Outside a section, do nothing and return false: the caller admits normally.
 */
export function deferFleetRunAdmission(key: string): boolean {
  const store = fleetRunAdmissionContext.getStore();
  if (!store) return false;
  store.deferred.add(key);
  return true;
}

/**
 * Detach `fn` from the current fleet admission context.
 *
 * A fire-and-forget execution spawned from a lock holder must not carry the
 * section's store past that section, or its later promotions would be deferred
 * into a collector nobody drains any more. `exit` runs `fn` (and the async work
 * it creates) without the store.
 */
export function runOutsideFleetRunAdmission<T>(fn: () => T): T {
  return fleetRunAdmissionContext.exit(fn);
}
