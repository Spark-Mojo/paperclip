import { deepStrictEqual, strictEqual, ok } from "node:assert";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";

// The newest snapshot in `src/migrations/meta` is the state `drizzle-kit
// generate` diffs the schema against. When it drifts from the schema, the next
// generated migration silently carries the drift: it re-adds a column an
// earlier migration already created (which fails on a fresh database) and drops
// a column the schema never had. This test reproduces the diff `generate`
// performs — schema modules versus newest snapshot — and fails when it is not
// empty, so drift is caught in CI instead of inside someone else's migration.

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const schemaDir = fileURLToPath(new URL("./schema", import.meta.url));

type JournalEntry = { idx: number; tag: string };

async function readNewestSnapshot(): Promise<{ file: string; snapshot: Record<string, unknown> }> {
  const journal = JSON.parse(
    await readFile(path.join(migrationsDir, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };
  const newest = journal.entries.at(-1);
  if (!newest) throw new Error("migration journal has no entries");
  const file = `${String(newest.idx).padStart(4, "0")}_snapshot.json`;
  const snapshot = JSON.parse(await readFile(path.join(migrationsDir, "meta", file), "utf8")) as Record<
    string,
    unknown
  >;
  return { file, snapshot };
}

// drizzle.config.ts points drizzle-kit at every module in the schema directory,
// so the test imports the same set rather than the hand-maintained barrel — a
// table missing from the barrel must not hide from this check.
async function importSchemaModules(): Promise<Record<string, unknown>> {
  const files = (await readdir(schemaDir)).filter((file) => file.endsWith(".ts")).sort();
  const exports: Record<string, unknown> = {};
  // The barrel re-exports the same table objects the per-table modules export,
  // so dedupe by identity: serializing one table twice trips drizzle-kit's
  // duplicate-index guard.
  const seen = new Set<unknown>();
  for (const file of files) {
    const module = (await import(pathToFileURL(path.join(schemaDir, file)).href)) as Record<
      string,
      unknown
    >;
    for (const [name, value] of Object.entries(module)) {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) continue;
        seen.add(value);
      }
      exports[`${file}#${name}`] = value;
    }
  }
  return exports;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type Snapshot = Parameters<typeof generateMigration>[0];

async function wakeGuardFixture() {
  const base = JSON.parse(await readFile(path.join(migrationsDir, "meta/0282_snapshot.json"), "utf8")) as Snapshot;
  const snapshot = JSON.parse(await readFile(path.join(migrationsDir, "meta/0283_snapshot.json"), "utf8")) as Snapshot;
  const generated = JSON.parse(JSON.stringify(generateDrizzleJson(await importSchemaModules(), base.id))) as Snapshot;
  const journal = JSON.parse(await readFile(path.join(migrationsDir, "meta/_journal.json"), "utf8"));
  const baseJournal = structuredClone({ ...journal, entries: journal.entries.slice(0, -1) });
  strictEqual(digest(JSON.stringify(baseJournal)), "587d44d444eed5caf76bbfa86bf7b64fa8aee90eda20ea3f153921ee1e6413e0");
  const sql = await readFile(path.join(migrationsDir, "0283_wake_loop_guard_index.sql"), "utf8");
  const priorIds = new Set<string>();
  for (const file of await readdir(path.join(migrationsDir, "meta"))) {
    if (!file.endsWith("_snapshot.json") || file === "0283_snapshot.json") continue;
    const prior = JSON.parse(await readFile(path.join(migrationsDir, "meta", file), "utf8"));
    priorIds.add(prior.id);
  }
  for (const [file, hash] of [
    ["0282_terminal_run_context_rewrite_block.sql", "b344d51f81583b58851d5541a942a3f9a423f5b340949ee9b8183bb4c5588c24"],
    ["meta/0282_snapshot.json", "d92cf3f24f0c32f9970742f67b3953d80489115af878c28ba87bdc1606e3c1fa"],
  ]) {
    strictEqual(digest(await readFile(path.join(migrationsDir, file), "utf8")), hash);
  }
  return { base, snapshot, generated, journal, baseJournal, sql, priorIds };
}

async function validateWakeGuard(fixture: Awaited<ReturnType<typeof wakeGuardFixture>>) {
  const { base, snapshot, generated, journal, baseJournal, sql, priorIds } = fixture;
  const semantic = (value: Snapshot) => {
    const { id, prevId, ...content } = value;
    return content;
  };
  ok(isDeepStrictEqual(semantic(snapshot), semantic(generated)), "complete snapshot schema mismatch");
  strictEqual(snapshot.version, "7");
  strictEqual(snapshot.dialect, "postgresql");
  ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(snapshot.id));
  ok(!priorIds.has(snapshot.id), "snapshot id must be unique");
  strictEqual(snapshot.prevId, base.id);
  strictEqual(priorIds.has(snapshot.prevId), true);
  const predecessors = (await readdir(path.join(migrationsDir, "meta"))).filter((file) => file.endsWith("_snapshot.json"));
  let predecessorCount = 0;
  for (const file of predecessors) {
    const prior = JSON.parse(await readFile(path.join(migrationsDir, "meta", file), "utf8"));
    if (prior.id === snapshot.prevId) predecessorCount += 1;
  }
  strictEqual(predecessorCount, 1);
  const { entries, ...metadata } = journal;
  const { entries: baseEntries, ...baseMetadata } = baseJournal;
  deepStrictEqual(metadata, baseMetadata);
  deepStrictEqual(entries.slice(0, -1), baseEntries);
  strictEqual(entries.length, baseEntries.length + 1);
  const last = entries.at(-1);
  deepStrictEqual({ ...last, when: undefined }, {
    idx: 283, version: "7", tag: "0283_wake_loop_guard_index", breakpoints: true, when: undefined,
  });
  strictEqual(baseEntries.at(-1).idx, 282);
  ok(Number.isSafeInteger(last.when) && last.when > baseEntries.at(-1).when);
  const statements = await generateMigration(base, snapshot);
  strictEqual(statements.length, 1);
  const expected = `CREATE INDEX "agent_wakeup_requests_company_agent_issue_created_idx" ON "agent_wakeup_requests" USING btree ("company_id","agent_id",("payload" ->> 'issueId'),"created_at");`;
  strictEqual(statements[0].trim(), expected);
  strictEqual(sql.replace(/^--[^\n]*(?:\n|$)/gm, "").trim(), expected);
}

describe("SPA-9280 snapshot reproduction", { timeout: 60_000 }, () => {
  it("reproduces complete schema, chain, append-only journal and exact index SQL", async () => {
    await validateWakeGuard(await wakeGuardFixture());
  });

  it("rejects semantic corruption", async () => {
    const fixture = await wakeGuardFixture();
    fixture.snapshot.tables = {};
    await expect(validateWakeGuard(fixture)).rejects.toThrow();
  });

  it("rejects duplicate generation identity and wrong predecessor", async () => {
    const fixture = await wakeGuardFixture();
    fixture.snapshot.id = fixture.base.id;
    await expect(validateWakeGuard(fixture)).rejects.toThrow();
    fixture.snapshot.id = "307c2746-3731-4bf2-896c-0160868f4000";
    fixture.snapshot.prevId = "00000000-0000-0000-0000-000000000000";
    await expect(validateWakeGuard(fixture)).rejects.toThrow();
  });

  it("rejects journal and SQL corruption", async () => {
    const fixture = await wakeGuardFixture();
    fixture.journal.entries[0].tag = "corrupted";
    await expect(validateWakeGuard(fixture)).rejects.toThrow();
    const sqlFixture = await wakeGuardFixture();
    sqlFixture.sql += '\nDROP TABLE "agent_wakeup_requests";';
    await expect(validateWakeGuard(sqlFixture)).rejects.toThrow();
  });
});

describe("migration snapshot drift", () => {
  it("keeps the newest snapshot in sync with the drizzle schema", async () => {
    const { file, snapshot } = await readNewestSnapshot();
    const current = generateDrizzleJson(await importSchemaModules(), snapshot.id as string);
    const statements = await generateMigration(
      snapshot as Parameters<typeof generateMigration>[0],
      current as Parameters<typeof generateMigration>[1],
    );

    expect(
      statements,
      `${file} no longer matches src/schema. Run \`pnpm --filter @paperclipai/db generate\` and commit the migration it emits; do not hand-edit the snapshot.`,
    ).toEqual([]);
  });
});
