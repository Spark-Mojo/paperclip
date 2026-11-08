EVIDENCE: vendor | none: worktree path carries no mojo project segment so no AGENT.md vendor applies; repo is Spark-Mojo/paperclip engine fork; scripts/vendor-check and scripts/vendor-paths.json absent
DELIVERABLE: d1 | craft: craft-tests | paths: server/src/__tests__/execution-workspace-sweep-inheritor.test.ts
GATE: g1 | deliverable: d1 | CHECK: pnpm vitest run server/src/__tests__/execution-workspace-sweep-inheritor.test.ts --reporter=basic | EXPECT: exit 1 | TIMEOUT: 900
GATE: g2 | deliverable: d1 | CHECK: pnpm vitest run server/src/__tests__/execution-workspace-sweep-inheritor.test.ts --reporter=basic | EXPECT: contains "failed" | TIMEOUT: 900
NEGATIVE: n1 | gate: g1 | CHECK: pnpm vitest run server/src/__tests__/execution-workspace-policy.test.ts --reporter=basic | EXPECT: exit 0 | TIMEOUT: 900
EVIDENCE: d1 | commit: 4b1d6234896d06ede9c10ae83dcf91d0ee45ec9b | gates: g1 PASS, g2 PASS, n1 PASS | critic: 0 blocking findings | at: 2026-11-08T04:00:00Z
