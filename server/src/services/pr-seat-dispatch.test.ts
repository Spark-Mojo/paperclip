/**
 * SPA-13735 d14 — PR seat-dispatch tests at the reachable service boundary.
 *
 * HONEST GAP (do not paper over): maybeDispatchSableSeatSummons and
 * applyPullRequestEvent are closure-private inside
 * githubConnectionEventService(...) in github-connection-events.ts — the
 * service returns only { pollOnce }, so the injected-options seam named in
 * the brief (createSeatSummons factory mock + resolveSeatCardIssue mock) is
 * NOT reachable from a test, and applyPullRequestEvent requires a live Db
 * (db.update(externalObjects)... runs before any dispatch logic). Exporting
 * that seam is d13's path — this file does NOT refactor the service.
 *
 * What this file pins instead: the exported decision contract the dispatch
 * path depends on (sable-seat-dispatch.ts pure functions) —
 * qualify → dedupeKey (passed verbatim as the interaction idempotencyKey in
 * the unexported dispatch) → seatCardTitle. If d13 exports the seam, these
 * become the fixtures for the create-called-once / tags assertions.
 *
 * Why changedFiles-carrying payloads: the leased seam fail-closes without a
 * file list (no_changed_files → log + skip; normalizeLeasedPayload carries
 * no changedFiles and no GitHub fetch may be added), so every dispatch case
 * below carries changedFiles explicitly.
 *
 * NOT proven here (needs the d13 seam): service.create called once,
 * payload.tags containing "seat-summons", and end-to-end second-event
 * suppression. The idempotency half IS proven: the dispatch passes
 * idempotencyKey = dedupeKey(ref), and dedupeKey stability across two
 * invocations for the same PR is asserted below.
 */
import { describe, expect, it } from "vitest";
import {
  dedupeKey,
  prQualifiesForSableSeat,
  seatCardTitle,
} from "./sable-seat-dispatch.js";

const OWNER = "spark-mojo";
const REPO = "paperclip";
const NUMBER = 42;

describe("pr-seat-dispatch — qualifying payload dispatches (d14)", () => {
  it("qualifying changedFiles mark the PR dispatch-eligible", () => {
    // opened/synchronize/reopened carrying a file list, no network involved.
    const verdict = prQualifiesForSableSeat({
      changedFiles: ["docker-compose.yml"],
    });
    expect(verdict.qualifies).toBe(true);
    expect(verdict.matchedPatterns.length).toBeGreaterThan(0);
  });

  it("idempotencyKey equals dedupeKey for that owner/repo/number", () => {
    // The dispatch passes idempotencyKey: dedupeKey({owner, repo, number}).
    expect(dedupeKey({ owner: OWNER, repo: REPO, number: NUMBER })).toBe(
      `sable-seat:${OWNER}/${REPO}#${NUMBER}`,
    );
  });

  it("seat card title names the same PR the key identifies", () => {
    expect(seatCardTitle({ owner: OWNER, repo: REPO, number: NUMBER })).toBe(
      `Sable review: ${OWNER}/${REPO}#${NUMBER}`,
    );
  });
});

describe("pr-seat-dispatch — non-qualifying payload does not create (d14)", () => {
  it("unrelated paths do not qualify, so no summons is filed", () => {
    const verdict = prQualifiesForSableSeat({
      changedFiles: ["docs/README.md"],
    });
    expect(verdict.qualifies).toBe(false);
    expect(verdict.matchedPatterns).toEqual([]);
  });

  it("empty file list does not qualify (fail-closed, no fetch added)", () => {
    expect(prQualifiesForSableSeat({ changedFiles: [] }).qualifies).toBe(
      false,
    );
  });
});

describe("pr-seat-dispatch — same PR twice suppressed by idempotencyKey (d14)", () => {
  it("two invocations for the same PR yield the same idempotencyKey", () => {
    const first = dedupeKey({ owner: OWNER, repo: REPO, number: NUMBER });
    const second = dedupeKey({ owner: OWNER, repo: REPO, number: NUMBER });
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it("different PRs yield different keys (no cross-PR suppression)", () => {
    expect(
      dedupeKey({ owner: OWNER, repo: REPO, number: NUMBER }),
    ).not.toBe(dedupeKey({ owner: OWNER, repo: REPO, number: NUMBER + 1 }));
  });
});
