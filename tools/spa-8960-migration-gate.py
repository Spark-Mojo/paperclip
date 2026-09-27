#!/usr/bin/env python3
"""SPA-8960 — migration ledger gate.

Answers the one question that matters before installing this branch: is the
live drizzle ledger already satisfied by this branch's own journal?

Why hashes and not counts: `loadAppliedMigrations()` in
packages/db/src/dist/client.js maps `drizzle.__drizzle_migrations` rows onto
migration files by SHA-256 content hash via `mapHashesToMigrationFiles`. A row
count is therefore not the safety oracle — SPA-8892 was mis-diagnosed on
exactly that. This script reproduces drizzle's own comparison so the answer is
the engine's answer, not a proxy for it.

PASS = every journal entry resolves to an applied DB row, 0 pending.
"""
import hashlib
import json
import pathlib
import subprocess
import sys

JOURNAL = pathlib.Path("packages/db/src/migrations/meta/_journal.json")
MIGRATIONS = pathlib.Path("packages/db/src/migrations")
DSN = "postgresql://paperclip:paperclip@127.0.0.1:5433/paperclip_spa_cutover_20260906"


def journal_hashes():
    entries = json.loads(JOURNAL.read_text())["entries"]
    out = {}
    for e in entries:
        f = MIGRATIONS / f"{e['tag']}.sql"
        if not f.is_file():
            raise SystemExit(f"journal entry has no file: {e['tag']}")
        out[hashlib.sha256(f.read_bytes()).hexdigest()] = e["tag"]
    return out, len(entries)


def db_hashes():
    r = subprocess.run(
        ["psql", DSN, "-tAc", "select hash from drizzle.__drizzle_migrations"],
        capture_output=True, text=True, env={"PGPASSWORD": "paperclip", "PATH": "/usr/bin:/bin"},
    )
    if r.returncode != 0:
        raise SystemExit(f"cannot read live ledger: {r.stderr.strip()[:200]}")
    return [h.strip() for h in r.stdout.splitlines() if h.strip()]


def main():
    want, n = journal_hashes()
    have = db_hashes()
    applied = [h for h in have if h in want]
    pending = [tag for h, tag in want.items() if h not in set(have)]

    print(f"journal entries (available): {n}")
    print(f"db rows: {len(have)}")
    print(f"journal entries already applied: {len(applied)}")
    print(f"pending: {len(pending)}")
    if pending:
        print("PENDING: " + ", ".join(pending[:20]))
    orphans = len(have) - len(applied)

    if pending:
        print("SPA-8960-MIGRATION-GATE: FAIL")
        return 1
    print(f"install is a migration no-op ({orphans} unmatched db row(s) are inert: "
          "unresolvable by hash, so drizzle ignores them)")
    print("SPA-8960-MIGRATION-GATE: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
