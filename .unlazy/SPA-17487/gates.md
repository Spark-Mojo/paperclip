DELIVERABLE: t1 | craft: craft-tests | paths: server/src/__tests__/issue-assignee-invokability-routes.test.ts | tests-for: d2
DELIVERABLE: d2 | craft: craft-general | paths: server/src/routes/issues.ts
GATE: g1 | deliverable: d2 | CHECK: npx vitest run server/src/__tests__/issue-assignee-invokability-routes.test.ts | EXPECT: exit 0
GATE: g2 | deliverable: d2 | CHECK: npx vitest run server/src/__tests__/issue-assignee-invokability-routes.test.ts -t delegation | EXPECT: exit 0
EVIDENCE: vendor | none: no platform/mojos/engine-fork/AGENT.md on origin/main, no vendor dir; per-need built-ins NONE; only vendor package server/src/vendor/paperclip-runner unrelated
EVIDENCE: d2+t1 | commit: 316aeb59f369602dfffed2e38154abd356015f2b | gates: g1 PASS (11 passed), g2 PASS (7 passed 4 skipped) | critic: 0 blocking, 2 advisory | at: 2026-11-07
EVIDENCE: t1 RED expected | gate-runner on new PATCH tests pre-d2: 1 failed (expected 200 to be 409) 8 passed | at: 2026-11-07
EVIDENCE: d2fix | commit: 47ade8128575e5aa82b009103a32bfbe0cd7d20a | gates: g1 PASS (11), g2 PASS | critic: no findings | at: 2026-11-07
EVIDENCE: intake-comment | SPA-17484 comment e6cafdeb-0f82-40d5-ba82-06e5f8a10154 | outcome: ABSENT proceeded, no post-bba6a45f0 upstream tags/commits | at: 2026-11-07
