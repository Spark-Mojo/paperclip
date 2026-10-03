SPA-10069 gates

Gate 1: A pending in_review agent participant with no run and no queued wake older than 15 minutes is reissued a stage wake; active run, queued wake, threshold, and non-pending stages do not receive one. Repeated sweeps do not duplicate the wake.
  CHECK: timeout 300 pnpm exec vitest run server/src/__tests__/heartbeat-process-recovery.test.ts server/src/__tests__/heartbeat-fleet-run-cap.test.ts server/src/__tests__/issue-execution-policy.test.ts -t 'SPA-10069'
  EXPECT: Test Files 3 passed; Tests 11 passed; exit 0.
  RESULT: exit 0 at 18:29Z as part of `timeout 300 pnpm exec vitest run server/src/__tests__/heartbeat-process-recovery.test.ts server/src/__tests__/heartbeat-fleet-run-cap.test.ts server/src/__tests__/issue-execution-policy.test.ts -t 'SPA-10069'`: Test Files 3 passed, Tests 11 passed, 425 skipped. Includes missing wake, prior-stage participant run, claim-time stage change, concurrent sweeps, legacy missing clock and four negative modes. The earlier arbitrary-cancellation retry control was withdrawn after checking that a recorded terminal run belongs to the existing recovery policy; no cancellation provenance was established, and the card only asks for absent/deferred wakes. Bucket idempotency bounds repeats but can delay retry after a lost recovery wake until the next 15-minute bucket; it is not immediate retry proof.
  NEGATIVE: timeout 300 pnpm exec vitest run server/src/__tests__/heartbeat-process-recovery.test.ts -t 'SPA-10069' before the implementation.
  NEGATIVE RESULT: exit 1 at 15:28Z: expected reviewParticipantRequeued 1, received 0, same assertion. Final fixture has no original wake/run and an aged stageEnteredAt; first failing control predates that fixture revision.

Gate 2: Server source typechecks.
  CHECK: timeout 300 pnpm exec tsc --noEmit -p server/tsconfig.json
  EXPECT: exit 0 with no errors.
  RESULT: exit 0 with empty output at 18:30Z. Repository full server typecheck (`timeout 600 pnpm --filter @paperclipai/server typecheck`) exits 1 before tsc because local cargo is absent; CI `ci / Typecheck + Release Registry` succeeded on PR #139 head 98ce522691927765af510138d63a689e470d4234.
  NEGATIVE: timeout 300 pnpm exec vitest run server/src/__tests__/heartbeat-process-recovery.test.ts -t 'SPA-10069' before the implementation.
  NEGATIVE RESULT: exit 1 at 15:28Z, expected reviewer requeue 1 received 0. This is a behavioural negative, not a direct tsc negative; the typecheck negative control remains unproven.
