DELIVERABLE: d1 | craft: craft-general | paths: server/src/routes/issues.ts
DELIVERABLE: d2 | craft: craft-general | paths: docs/engine-repair/delegation-cycle-guards.md
GATE: g1 | deliverable: d1 | CHECK: npx vitest run server/src/__tests__/issue-assignee-invokability-routes.test.ts | EXPECT: exit 0
GATE: g2 | deliverable: d1 | CHECK: git merge --no-edit origin/rebuild/v2026.1012.0 | EXPECT: contains "Already up to date"
GATE: g3 | deliverable: d2 | CHECK: git status --porcelain -- docs/engine-repair | EXPECT: exit 0
EVIDENCE: vendor | none: no platform/mojos/engine/AGENT.md on origin/main (48 AGENT.md under platform/mojos, none engine-named; only sparkmojo-auth/whiteboard carry vendor:); per-need built-ins NONE — assertNoAgentDelegationCycle guard (server/src/routes/issues.ts:7223) and its oracles are engine-fork-specific
