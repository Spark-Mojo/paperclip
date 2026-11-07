DELIVERABLE: d1 | craft: craft-general | paths: server/src/routes/issues.ts
DELIVERABLE: d2 | craft: craft-general | paths: docs/engine-repair/delegation-cycle-guards.md
GATE: g1 | deliverable: d1 | CHECK: npx vitest run server/src/__tests__/issue-assignee-invokability-routes.test.ts | EXPECT: exit 0
GATE: g2 | deliverable: d1 | CHECK: git merge --no-edit origin/rebuild/v2026.1012.0 | EXPECT: contains "Already up to date"
GATE: g3 | deliverable: d2 | CHECK: git status --porcelain -- docs/engine-repair | EXPECT: exit 0
EVIDENCE: vendor | none: no platform/mojos/engine/AGENT.md on origin/main (48 AGENT.md under platform/mojos, none engine-named; only sparkmojo-auth/whiteboard carry vendor:); per-need built-ins NONE — assertNoAgentDelegationCycle guard (server/src/routes/issues.ts:7223) and its oracles are engine-fork-specific
EVIDENCE: d2 | commit: 38ed629938eb0572f1f8b220c77d67a34d2a5f04 | gates: g1 PASS (16/16), g2 PASS (Already up to date), g3 PASS (exit 0) | critic: 0 blocking (2 advisory fixed, re-review clean) | at: 2026-11-07
EVIDENCE: d1-preserved | merge origin/rebuild/v2026.1012.0 is ancestor of HEAD (merge no-op "Already up to date"); guards intact in server/src/routes/issues.ts (helper 7223, decomposition 12378, PATCH 13462/13475/13488) | g1 oracle suite PASS 16/16 | at: 2026-11-07
