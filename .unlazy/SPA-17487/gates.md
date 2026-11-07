DELIVERABLE: t1 | craft: craft-tests | paths: server/src/__tests__/issue-assignee-invokability-routes.test.ts | tests-for: d2
DELIVERABLE: d2 | craft: craft-general | paths: server/src/routes/issues.ts
GATE: g1 | deliverable: d2 | CHECK: npx vitest run server/src/__tests__/issue-assignee-invokability-routes.test.ts | EXPECT: exit 0
GATE: g2 | deliverable: d2 | CHECK: npx vitest run server/src/__tests__/issue-assignee-invokability-routes.test.ts -t delegation | EXPECT: exit 0
EVIDENCE: vendor | none: no platform/mojos/engine-fork/AGENT.md on origin/main, no vendor dir; per-need built-ins NONE; only vendor package server/src/vendor/paperclip-runner unrelated
