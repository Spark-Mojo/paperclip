# SPA-10859 gates — compare-and-set on PATCH /api/issues/:id

Boundary: Dex option (a) — mandatory CAS only for board actors on the HTTP
PATCH route, ownership-transmit fields only, transfer-only trigger; status
CAS opt-in; in-tree service callers intact.

## DELIVERABLEs

- DELIVERABLE: cas-route | paths: server/src/routes/issues.ts, server/src/services/issues.ts, packages/shared/src/validators/issue.ts, server/src/__tests__/issue-write-ownership-cas-routes.test.ts
- DELIVERABLE: cas-ui | paths: ui/src/pages/IssueDetail.tsx, ui/src/pages/Pipelines.tsx, ui/src/components/TaskChatThread.tsx, ui/src/components/OnboardingChat.tsx, ui/src/components/IssuesList.tsx, ui/src/components/LegacyIssuesList.tsx, ui/src/components/issue-properties/IssueProperties.tsx

## GATEs

- GATE: G1 | deliverable: cas-route | CHECK: ./node_modules/.bin/vitest run packages/shared/src/validators/issue.test.ts
- EXPECT: exit 0, 30 passed
- RESULT: PASS — 30/30 (2026-10-10 run)
- NEGATIVE: validator rejects unknown expected key — covered by route-level 409 controls below, not a separate binary fixture

- GATE: G2 | deliverable: cas-route | CHECK: ./node_modules/.bin/vitest run server/src/__tests__/issue-write-ownership-cas-routes.test.ts
- EXPECT: exit 0, 15 passed (positive control + sweep-shape negative + TOCTOU + composer-shape boundaries)
- RESULT: PASS — 15/15 (2026-10-10 run)
- NEGATIVE: stale expectedStatus → 409 cas-mismatch, row untouched (in-suite); missing expectedAssignee* on transfer → 409 cas-missing, row untouched (in-suite)

- GATE: G3 | deliverable: cas-route | CHECK: ./node_modules/.bin/vitest run server/src/services/native-runtime/paperclip-runner-tool-authority.test.ts
- EXPECT: exit 0, 16 passed (Dex head-only-red regression)
- RESULT: PASS — 16/16 (2026-10-10 run)
- NEGATIVE: under the pre-fix service-wide CAS this suite failed 570 passed | 1 failed with issue_write_ownership_cas_missing at issues.ts:6682 (Dex 2026-10-05 read, run 37256283710); current opt-in boundary restores 16/16

- GATE: G4 | deliverable: cas-route + cas-ui | CHECK: ./node_modules/.bin/tsc --noEmit -p tsconfig.json (ui) ; ./node_modules/.bin/tsc --noEmit -p packages/shared/tsconfig.json
- EXPECT: exit 0 both
- RESULT: PASS — ui exit 0, shared exit 0 (2026-10-10 run)
- NEGATIVE: n/a (typecheck is fail-closed: any type error is a nonzero exit)

- GATE: G5 | deliverable: cas-route | CHECK: ./node_modules/.bin/tsc --noEmit -p server/tsconfig.json, filtered for touched files
- EXPECT: 251 pre-existing errors at base AND head (byte-identical count, zero errors in routes/issues.ts, services/issues.ts, validators/issue.ts, cas test)
- RESULT: PASS — 251 at head, 251 at stashed base, zero in touched files (2026-10-10 run)
- NEGATIVE: n/a (count-equality is the control; a new error in a touched file fails the gate)
