# SPA-9423 lease gates

- L1 — every terminal transition including interrupted/orphaned releases its run's lease; native/retained safeguards survive.
  CHECK: `timeout 900 pnpm -C server exec vitest run src/services/terminal-environment-leases.test.ts --disable-console-intercept`
  EXPECT: `LEASE-GATES: terminal-release`
  RESULT: PASS — exit 0; matched; covers succeeded/failed/cancelled/interrupted direct paths AND the actual `drainRunningRunsForShutdown("SIGTERM", ...)` path AND the `server_shutdown_interrupted` shutdown-style wire AND the `lease_released_before_terminal` orphan-error-code shape; `retained` survives.

- L2 — startup and periodic reclaim terminal owners only, isolating driver failures.
  CHECK: `timeout 900 pnpm -C server exec vitest run src/services/terminal-environment-leases.test.ts --disable-console-intercept`
  EXPECT: `LEASE-GATES: sweep-guards`
  RESULT: PASS — exit 0; matched; terminal owner reclaims, live + queued skipped, cross-company skipped, ownership-changed skipped.

- L3 — local ephemeral acquisitions have finite expiry without killing a live owner.
  CHECK: `timeout 900 pnpm -C server exec vitest run src/services/terminal-environment-leases.test.ts --disable-console-intercept`
  EXPECT: `LEASE-GATES: finite-expiry`
  RESULT: PASS — exit 0; matched; expiresAt persisted on the lease row; expiry alone is never the reclaim predicate.

- L4 — restart reconciles live retry's prior owner to terminal, releases its lease, and dispatches a bounded replacement, in that order.
  CHECK: `timeout 900 pnpm -C server exec vitest run src/services/terminal-environment-leases.test.ts --disable-console-intercept`
  EXPECT: `LEASE-GATES: restart-replacement`
  RESULT: PASS — exit 0; matched; lease released by the terminal-owner path, replacement run id distinct from the original, replacementDispatchFailures empty, production wiring in server/src/index.ts asserted.
