import { describe, expect, it } from "vitest";
import { assertDisposableTestDatabaseTarget } from "./test-database-safety.js";

describe("assertDisposableTestDatabaseTarget", () => {
  it("returns a sanitized identity for a loopback disposable database", () => {
    expect(
      assertDisposableTestDatabaseTarget("postgres://paperclip:paperclip@127.0.0.1:55432/paperclip"),
    ).toEqual({
      host: "127.0.0.1",
      port: "55432",
      database: "paperclip",
    });
  });

  it("refuses the protected BigBox database name before connecting", () => {
    expect(() =>
      assertDisposableTestDatabaseTarget(
        "postgres://paperclip:paperclip@127.0.0.1:5432/paperclip_spa_cutover_20260906",
      ),
    ).toThrow("refuses protected database");
  });

  it("refuses an externally configured database host before connecting", () => {
    expect(() =>
      assertDisposableTestDatabaseTarget("postgres://paperclip:paperclip@bigbox.example.test:5432/paperclip"),
    ).toThrow("must use a loopback host");
  });
});
