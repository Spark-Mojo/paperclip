import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { validatedCompanyDefaultResponsibleUserId } from "../services/issue-execution-policy.ts";

function dbReturning(principalId: string | null): Db {
  const terminal = Promise.resolve(principalId === null ? [] : [{ principalId }]);
  const query = {
    from: () => query,
    innerJoin: () => query,
    where: () => query,
    limit: () => terminal,
  };
  return { select: () => query } as unknown as Db;
}

// NOTE: dbReturning() is a query-shape double. It ignores every predicate
// (company, principalType "user", status "active", defaultResponsibleUserId
// match), so these cases pin ONLY how validatedCompanyDefaultResponsibleUserId
// post-processes whatever row the query yields. The SQL predicates themselves
// need a real-DB test and are NOT covered here.
describe("validatedCompanyDefaultResponsibleUserId result handling (query double, predicates not exercised)", () => {
  it("rejects the local-board sentinel when the query yields it", async () => {
    const result = await validatedCompanyDefaultResponsibleUserId(
      dbReturning("local-board"),
      "company-a",
    );

    expect(result).toBeNull();
    expect(result).not.toBe("local-board");
  });

  it.each([
    ["whitespace-padded sentinel", " local-board "],
    // A padded id can never equal a real membership principalId, so it fails
    // closed (null) rather than being silently trimmed into a different value.
    ["whitespace-padded real-looking principal", " user-real-human-0001 "],
    ["leading-padded real-looking principal", " user-real-human-0001"],
    ["trailing-padded real-looking principal", "user-real-human-0001 "],
    ["empty-string principal", ""],
    ["whitespace-only principal", "   "],
  ])("returns null for a %s", async (_label, principalId) => {
    await expect(
      validatedCompanyDefaultResponsibleUserId(dbReturning(principalId), "company-a"),
    ).resolves.toBeNull();
  });

  it("returns null when the query yields no row ([])", async () => {
    await expect(
      validatedCompanyDefaultResponsibleUserId(dbReturning(null), "company-a"),
    ).resolves.toBeNull();
  });

  it("returns a real human principal the query yields", async () => {
    const humanUserId = "user-real-human-0001";

    await expect(
      validatedCompanyDefaultResponsibleUserId(dbReturning(humanUserId), "company-a"),
    ).resolves.toBe(humanUserId);
  });

  it("returns the ORIGINAL principalId string (no trim-copy divergence) for a non-blank, non-sentinel id", async () => {
    const humanUserId = "user-real-human-0001";
    const result = await validatedCompanyDefaultResponsibleUserId(dbReturning(humanUserId), "company-a");

    expect(result).toBe(humanUserId);
    expect(result).toHaveLength(humanUserId.length);
  });
});
