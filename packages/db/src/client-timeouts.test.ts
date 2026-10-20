import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DATABASE_LOCK_TIMEOUT_MS,
  DEFAULT_DATABASE_POOL_MAX,
  DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS,
  createDb,
  databaseClientOptionsFromEnv,
  postgresJsOptions,
  resolveDatabaseClientOptions,
} from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

describe("databaseClientOptionsFromEnv timeouts", () => {
  it("returns no timeout options when nothing is set", () => {
    expect(databaseClientOptionsFromEnv({})).toEqual({});
  });

  it("parses explicit timeout values", () => {
    expect(
      databaseClientOptionsFromEnv({
        DATABASE_STATEMENT_TIMEOUT_MS: "15000",
        DATABASE_LOCK_TIMEOUT_MS: "1000",
      }),
    ).toEqual({ statementTimeoutMs: 15000, lockTimeoutMs: 1000 });
  });

  it("ignores empty values, falling back to defaults", () => {
    expect(
      databaseClientOptionsFromEnv({
        DATABASE_STATEMENT_TIMEOUT_MS: "",
        DATABASE_LOCK_TIMEOUT_MS: "  ",
      }),
    ).toEqual({});
  });

  it("rejects malformed timeout values with the same Error style as existing parsers", () => {
    expect(() => databaseClientOptionsFromEnv({ DATABASE_STATEMENT_TIMEOUT_MS: "abc" })).toThrow(
      /DATABASE_STATEMENT_TIMEOUT_MS must be a non-negative integer/,
    );
    expect(() => databaseClientOptionsFromEnv({ DATABASE_LOCK_TIMEOUT_MS: "1.5" })).toThrow(
      /DATABASE_LOCK_TIMEOUT_MS must be a non-negative integer/,
    );
    expect(() => databaseClientOptionsFromEnv({ DATABASE_STATEMENT_TIMEOUT_MS: "-3" })).toThrow(
      /DATABASE_STATEMENT_TIMEOUT_MS/,
    );
    expect(() => databaseClientOptionsFromEnv({ DATABASE_LOCK_TIMEOUT_MS: "NaN" })).toThrow(
      /DATABASE_LOCK_TIMEOUT_MS/,
    );
  });

  it("accepts 0 as disable (Postgres semantics: 0 means no timeout)", () => {
    expect(
      databaseClientOptionsFromEnv({
        DATABASE_STATEMENT_TIMEOUT_MS: "0",
        DATABASE_LOCK_TIMEOUT_MS: "0",
      }),
    ).toEqual({ statementTimeoutMs: 0, lockTimeoutMs: 0 });
  });
});

describe("postgresJsOptions timeout mapping", () => {
  it("maps timeouts to postgres.js connection parameters as millisecond strings", () => {
    expect(postgresJsOptions({ statementTimeoutMs: 15000, lockTimeoutMs: 1000 })).toEqual({
      connection: { statement_timeout: "15000", lock_timeout: "1000" },
    });
  });

  it("merges timeouts with application_name in one connection object", () => {
    expect(
      postgresJsOptions({ applicationName: "paperclip-web", statementTimeoutMs: 5000, lockTimeoutMs: 5000 }),
    ).toEqual({
      connection: { application_name: "paperclip-web", statement_timeout: "5000", lock_timeout: "5000" },
    });
  });

  it("omits connection entirely when none of its inputs are set", () => {
    expect(postgresJsOptions({ maxConnections: 10 })).toEqual({ max: 10 });
  });
});

describe("resolveDatabaseClientOptions timeout and pool defaults", () => {
  it("applies statement/lock timeout and pool-max defaults", () => {
    expect(resolveDatabaseClientOptions({})).toMatchObject({
      maxConnections: DEFAULT_DATABASE_POOL_MAX,
      statementTimeoutMs: DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS,
      lockTimeoutMs: DEFAULT_DATABASE_LOCK_TIMEOUT_MS,
    });
    expect(DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS).toBe(5000);
    expect(DEFAULT_DATABASE_LOCK_TIMEOUT_MS).toBe(5000);
    expect(DEFAULT_DATABASE_POOL_MAX).toBe(10);
  });

  it("lets explicit values win over the defaults", () => {
    expect(
      resolveDatabaseClientOptions({ maxConnections: 3, statementTimeoutMs: 15000, lockTimeoutMs: 1000 }),
    ).toMatchObject({ maxConnections: 3, statementTimeoutMs: 15000, lockTimeoutMs: 1000 });
  });

  it("flows defaults through to driver options on the env-only path", () => {
    expect(postgresJsOptions(resolveDatabaseClientOptions(databaseClientOptionsFromEnv({})))).toEqual({
      max: DEFAULT_DATABASE_POOL_MAX,
      idle_timeout: 60,
      connection: {
        application_name: "paperclip",
        statement_timeout: String(DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS),
        lock_timeout: String(DEFAULT_DATABASE_LOCK_TIMEOUT_MS),
      },
    });
  });
});

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

describeEmbeddedPostgres("createDb timeout startup params (live)", () => {
  it("applies the 5s statement/lock timeout defaults on connections", async () => {
    const db = await startEmbeddedPostgresTestDatabase("paperclip-db-timeouts-");
    cleanups.push(db.cleanup);
    const client = createDb(db.connectionString);
    cleanups.push(async () => {
      await client.$client.end({ timeout: 1 });
    });
    const [statement] = await client.$client<{ statement_timeout: string }[]>`SHOW statement_timeout`;
    const [lock] = await client.$client<{ lock_timeout: string }[]>`SHOW lock_timeout`;
    expect(statement?.statement_timeout).toBe("5s");
    expect(lock?.lock_timeout).toBe("5s");
  }, 30_000);
});
