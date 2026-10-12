# SPA-11865 — heartbeat agent-window query de-toast fix

## DELIVERABLE: spa-11865-migration
- craft: craft-general
- paths:
  - packages/db/src/migrations/9284_heartbeat_context_snapshot_id_columns.sql (new)
  - packages/db/src/migrations/meta/_journal.json (idx 9284 appended)
  - packages/db/src/schema/heartbeat_runs.ts (two STORED generated columns)

### GATE: spa-11865-mig-numbering-ok
- deliverable: spa-11865-migration
- CHECK: timeout 60 pnpm --filter @paperclipai/db run check:migrations
- EXPECT: exit 0; stdout contains "Migration safety check passed"
- NEGATIVE: rename the migration file to a colliding 4-digit prefix and confirm `check:migrations` exits nonzero
  - observed nonzero exit on a disposable fixture where two migration files share a 4-digit prefix

### GATE: spa-11865-mig-db-typecheck-ok
- deliverable: spa-11865-migration
- CHECK: timeout 240 pnpm --filter @paperclipai/db run typecheck
- EXPECT: exit 0
- NEGATIVE: introduce a known-bad type in heartbeat_runs.ts (e.g. `contextIssueId: number(...)` over a text column) and confirm exit nonzero
  - this test is structural: only run if the gate fails; do not mutate the schema file as part of the gate run

## DELIVERABLE: spa-11865-caller-fix
- craft: craft-general
- paths:
  - server/src/services/attention.ts (lines 1671-1695 — projection of generated columns)

### GATE: spa-11865-caller-typecheck-ok
- deliverable: spa-11865-caller-fix
- CHECK: timeout 240 sh -c 'cd server && timeout 240 npx tsc --noEmit 2>&1 | grep -E "(heartbeat_runs|attention\\.ts)"; exit ${PIPESTATUS[0]}'
- EXPECT: exit 0; stdout is empty (no errors involving heartbeat_runs or attention.ts)
- NEGATIVE: insert `as unknown as number` in the runIssueId assignment and confirm grep returns nonzero

## DELIVERABLE: spa-11865-test
- craft: craft-tests
- paths:
  - packages/db/src/heartbeat-context-snapshot-id-columns-migration.test.ts (new)

### GATE: spa-11865-test-applies
- deliverable: spa-11865-test
- CHECK: timeout 600 pnpm --filter @paperclipai/db exec vitest run packages/db/src/heartbeat-context-snapshot-id-columns-migration.test.ts -t "applies the migration and lands the new generated columns"
- EXPECT: exit 0; test output contains "+ applied"
- NEGATIVE: drop the new ADD COLUMN line from the migration and confirm the test fails on the missing column
  - structural; do not mutate the migration as part of the gate run

### GATE: spa-11865-test-explains-ioscan
- deliverable: spa-11865-test
- CHECK: timeout 600 pnpm --filter @paperclipai/db exec vitest run packages/db/src/heartbeat-context-snapshot-id-columns-migration.test.ts -t "populates the generated columns from existing rows"
- EXPECT: exit 0
- NEGATIVE: replace the `enable_seqscan = off` SET with `enable_indexscan = off` and confirm the test fails on plan shape
  - structural; do not mutate the test as part of the gate run

### GATE: spa-11865-test-schema-and-journal
- deliverable: spa-11865-test
- CHECK: timeout 600 pnpm --filter @paperclipai/db exec vitest run packages/db/src/heartbeat-context-snapshot-id-columns-migration.test.ts -t "declares the generated columns in the drizzle schema"
- EXPECT: exit 0
- NEGATIVE: drop the `.generatedAlwaysAs` callback from one column and confirm the test fails on missing callback form

### GATE: spa-11865-test-idempotent
- deliverable: spa-11865-test
- CHECK: timeout 600 pnpm --filter @paperclipai/db exec vitest run packages/db/src/heartbeat-context-snapshot-id-columns-migration.test.ts -t "is idempotent on re-run"
- EXPECT: exit 0
- NEGATIVE: change `IF NOT EXISTS` on the index to omit it and confirm the test fails with a duplicate-index error
  - structural; do not mutate the migration as part of the gate run