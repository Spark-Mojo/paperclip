import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, instanceSettings } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres fleet-cap-lock tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// SPA-10137 Mira review round 2: the fleet-max-concurrent-runs PATCH route
// (server/src/routes/instance-settings.ts) serializes its read-write-read
// critical section with a Postgres advisory lock (pg_advisory_xact_lock)
// instead of a process-local queue, so two PATCHes landing on different
// server replicas -- which share only this database, not a process -- still
// cannot interleave. instance-settings-routes.test.ts proves (with mocks)
// that the route asks for this exact lock, with this exact key, before
// touching the row. This file proves the lock itself does what the route
// depends on: a second acquisition of the SAME key genuinely waits for the
// first to release, using a real Postgres connection -- the one thing a
// mocked db.transaction cannot demonstrate. Same technique as the existing
// proof for this general mechanism in folders-service.test.ts ("rechecks
// nested folders after waiting for the company mutation lock"), applied to
// this feature's own lock key, and additionally exercised through the real
// instanceSettingsService.getGeneral/updateGeneral(..., { db: tx }) paths
// the route actually calls.
const FLEET_MAX_CONCURRENT_RUNS_LOCK_KEY = "paperclip:instance-settings:fleet-max-concurrent-runs";

describeEmbeddedPostgres("fleet-max-concurrent-runs advisory lock (SPA-10137)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-fleet-cap-lock-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("blocks a second acquisition of the same key until the first transaction releases it", async () => {
    let releaseFirst!: () => void;
    let markFirstAcquired!: () => void;
    const firstAcquired = new Promise<void>((resolve) => {
      markFirstAcquired = resolve;
    });
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${FLEET_MAX_CONCURRENT_RUNS_LOCK_KEY}, 0))`,
      );
      markFirstAcquired();
      await holdFirst;
    });
    await firstAcquired;

    let secondAcquired = false;
    const second = db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${FLEET_MAX_CONCURRENT_RUNS_LOCK_KEY}, 0))`,
      );
      secondAcquired = true;
    });

    // The second attempt must still be waiting a beat after the first holds
    // the lock -- not a fixed-duration race, but a real check that it has not
    // slipped through.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(secondAcquired).toBe(false);

    releaseFirst();
    await first;
    await second;
    expect(secondAcquired).toBe(true);
  }, 20_000);

  it("serializes a real read-modify-write through instanceSettingsService(...).{getGeneral,updateGeneral}(..., { db: tx })", async () => {
    const svc = instanceSettingsService(db);
    await svc.updateGeneral({ fleetMaxConcurrentRuns: 2 });

    let releaseFirst!: () => void;
    let markFirstWriting!: () => void;
    const firstWriting = new Promise<void>((resolve) => {
      markFirstWriting = resolve;
    });
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    // Mirrors the route's critical section: lock, read previous, write next.
    const firstTransition = db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${FLEET_MAX_CONCURRENT_RUNS_LOCK_KEY}, 0))`,
      );
      const previous = await svc.getGeneral({ db: tx });
      expect(previous.fleetMaxConcurrentRuns).toBe(2);
      markFirstWriting();
      await holdFirst;
      return svc.updateGeneral({ fleetMaxConcurrentRuns: 10 }, { db: tx });
    });
    await firstWriting;

    let secondSawCommittedValue: number | null | undefined;
    const secondTransition = db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${FLEET_MAX_CONCURRENT_RUNS_LOCK_KEY}, 0))`,
      );
      // Reachable only once the first transition has committed (the lock
      // guarantees it), so this MUST see 10, never the pre-first value of 2.
      const previous = await svc.getGeneral({ db: tx });
      secondSawCommittedValue = previous.fleetMaxConcurrentRuns;
      return svc.updateGeneral({ fleetMaxConcurrentRuns: 1 }, { db: tx });
    });

    releaseFirst();
    await firstTransition;
    await secondTransition;

    expect(secondSawCommittedValue).toBe(10);
    const finalGeneral = await svc.getGeneral();
    expect(finalGeneral.fleetMaxConcurrentRuns).toBe(1);
  }, 20_000);
});
