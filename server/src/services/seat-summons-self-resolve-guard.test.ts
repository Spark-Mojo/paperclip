import { describe, expect, it } from "vitest";
import {
  evaluateSeatSummonsResolve,
  isSeatSummonsInteraction,
} from "./seat-summons-self-resolve-guard.js";

describe("isSeatSummonsInteraction", () => {
  it("detects a seat kind", () => {
    expect(isSeatSummonsInteraction({ kind: "sable-seat-summons" })).toBe(true);
  });

  it("detects a summons tag", () => {
    expect(isSeatSummonsInteraction({ kind: "question", tags: ["seat-summons"] }))
      .toBe(true);
  });

  it("refuses a non-summons interaction", () => {
    expect(isSeatSummonsInteraction({ kind: "question", tags: ["review"] }))
      .toBe(false);
  });

  it("refuses null/invalid input (fail-closed)", () => {
    expect(isSeatSummonsInteraction(null)).toBe(false);
    expect(isSeatSummonsInteraction(undefined)).toBe(false);
  });

  it("refuses non-object input shapes (fail-closed)", () => {
    expect(isSeatSummonsInteraction("seat-summons" as unknown as { kind?: string })).toBe(false);
    expect(isSeatSummonsInteraction(42 as unknown as { kind?: string })).toBe(false);
    expect(isSeatSummonsInteraction(["seat-summons"] as unknown as { kind?: string })).toBe(false);
  });

  it("detects the sable-seat tag variant and uppercase kinds", () => {
    expect(isSeatSummonsInteraction({ kind: "question", tags: ["SABLE-SEAT"] })).toBe(true);
    expect(isSeatSummonsInteraction({ kind: "SEAT SUMMONS" })).toBe(true);
    expect(isSeatSummonsInteraction({ kind: "Summons" })).toBe(true);
  });
});

describe("evaluateSeatSummonsResolve", () => {
  it("refuses author-actor self-resolve with auditNote naming it", () => {
    const decision = evaluateSeatSummonsResolve({
      isSummons: true,
      resolverActorId: "agent-1",
      resolverActorType: "agent",
      prAuthorActorId: "agent-1",
      prAuthorActorType: "agent",
      creatorAgentId: "agent-2",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("author_actor_self_resolve_refused");
    expect(decision.auditNote).toContain("author-actor self-resolve refused");
  });

  it("refuses creator self-resolve under a not_creator summons", () => {
    const decision = evaluateSeatSummonsResolve({
      isSummons: true,
      resolverActorId: "agent-9",
      resolverActorType: "agent",
      prAuthorActorId: "agent-1",
      prAuthorActorType: "agent",
      creatorAgentId: "agent-9",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("creator_self_resolve_refused");
    expect(decision.auditNote).toContain("creator self-resolve refused");
  });

  it("allows an unrelated third-party resolver", () => {
    const decision = evaluateSeatSummonsResolve({
      isSummons: true,
      resolverActorId: "agent-3",
      resolverActorType: "agent",
      prAuthorActorId: "agent-1",
      prAuthorActorType: "agent",
      creatorAgentId: "agent-2",
    });
    expect(decision).toMatchObject({ allowed: true, code: "allow" });
  });

  it("refuses missing resolver identity (fail-closed)", () => {
    const decision = evaluateSeatSummonsResolve({
      isSummons: true,
      resolverActorId: null,
      resolverActorType: "agent",
      prAuthorActorId: "agent-1",
      prAuthorActorType: "agent",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("resolver_identity_invalid");
    expect(decision.auditNote).toContain("fail-closed");
  });

  it("refuses an invalid resolver actor type with a distinct code", () => {
    const decision = evaluateSeatSummonsResolve({
      isSummons: true,
      resolverActorId: "agent-3",
      resolverActorType: "service",
      prAuthorActorId: "agent-1",
      prAuthorActorType: "agent",
      creatorAgentId: "agent-2",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("resolver_identity_invalid");
  });

  it("does not match the author across actor types (same raw ID)", () => {
    const decision = evaluateSeatSummonsResolve({
      isSummons: true,
      resolverActorId: "actor-1",
      resolverActorType: "agent",
      prAuthorActorId: "actor-1",
      prAuthorActorType: "user",
      creatorAgentId: "agent-2",
    });
    expect(decision).toMatchObject({ allowed: true, code: "allow" });
  });

  it("does not match the creator held only on the other side (same raw ID)", () => {
    const decision = evaluateSeatSummonsResolve({
      isSummons: true,
      resolverActorId: "actor-9",
      resolverActorType: "agent",
      prAuthorActorId: "agent-1",
      prAuthorActorType: "agent",
      creatorAgentId: "agent-2",
      creatorUserId: "actor-9",
    });
    expect(decision).toMatchObject({ allowed: true, code: "allow" });
  });

  it("refuses when the author type is missing (fail-closed)", () => {
    const decision = evaluateSeatSummonsResolve({
      isSummons: true,
      resolverActorId: "agent-3",
      resolverActorType: "agent",
      prAuthorActorId: "agent-1",
      prAuthorActorType: null,
      creatorAgentId: "agent-2",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.auditNote).toContain("fail-closed");
  });

  it("refuses when isSummons is false or undefined (fail-closed)", () => {
    for (const isSummons of [false, undefined] as const) {
      const decision = evaluateSeatSummonsResolve({
        isSummons,
        resolverActorId: "agent-3",
        resolverActorType: "agent",
        prAuthorActorId: "agent-1",
        prAuthorActorType: "agent",
        creatorAgentId: "agent-2",
      });
      expect(decision.allowed).toBe(false);
      expect(decision.auditNote).toContain("fail-closed");
    }
  });

  it("refuses when the creator identity is missing (fail-closed)", () => {
    const decision = evaluateSeatSummonsResolve({
      isSummons: true,
      resolverActorId: "agent-3",
      resolverActorType: "agent",
      prAuthorActorId: "agent-1",
      prAuthorActorType: "agent",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.auditNote).toContain("fail-closed");
  });

  it("rejects seating/assessment kinds (word-boundary seat/summons)", () => {
    expect(isSeatSummonsInteraction({ kind: "seating-chart" })).toBe(false);
    expect(isSeatSummonsInteraction({ kind: "assessment" })).toBe(false);
    expect(isSeatSummonsInteraction({ kind: "seat" })).toBe(true);
  });

  it("names author and creator identities in the allow auditNote", () => {
    const decision = evaluateSeatSummonsResolve({
      isSummons: true,
      resolverActorId: "agent-3",
      resolverActorType: "agent",
      prAuthorActorId: "agent-1",
      prAuthorActorType: "agent",
      creatorAgentId: "agent-2",
    });
    expect(decision.auditNote).toContain("agent:agent-1");
    expect(decision.auditNote).toContain("agent:agent-2");
  });

  it("refuses a user resolver matching the user-side creator", () => {
    const decision = evaluateSeatSummonsResolve({
      isSummons: true,
      resolverActorId: "user-9",
      resolverActorType: "user",
      prAuthorActorId: "agent-1",
      prAuthorActorType: "agent",
      creatorAgentId: "agent-2",
      creatorUserId: "user-9",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("creator_self_resolve_refused");
    expect(decision.auditNote).toContain("creator self-resolve refused");
  });

  it("allows an unrelated user resolver on the user creator side", () => {
    const decision = evaluateSeatSummonsResolve({
      isSummons: true,
      resolverActorId: "user-3",
      resolverActorType: "user",
      prAuthorActorId: "agent-1",
      prAuthorActorType: "agent",
      creatorAgentId: "agent-2",
      creatorUserId: "user-2",
    });
    expect(decision).toMatchObject({ allowed: true, code: "allow" });
    expect(decision.auditNote).toContain("user:user-3");
  });

  it("refuses null/undefined input as invalid resolver identity", () => {
    for (const input of [null, undefined] as const) {
      const decision = evaluateSeatSummonsResolve(input);
      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe("resolver_identity_invalid");
      expect(decision.auditNote).toContain("fail-closed");
    }
  });

  it("refuses whitespace-only IDs (fail-closed)", () => {
    const decision = evaluateSeatSummonsResolve({
      isSummons: true,
      resolverActorId: "   ",
      resolverActorType: "agent",
      prAuthorActorId: "agent-1",
      prAuthorActorType: "agent",
      creatorAgentId: "agent-2",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("resolver_identity_invalid");
    const creatorBlank = evaluateSeatSummonsResolve({
      isSummons: true,
      resolverActorId: "agent-3",
      resolverActorType: "agent",
      prAuthorActorId: "agent-1",
      prAuthorActorType: "agent",
      creatorAgentId: "  ",
    });
    expect(creatorBlank.allowed).toBe(false);
    expect(creatorBlank.code).toBe("creator_self_resolve_refused");
    expect(creatorBlank.auditNote).toContain("fail-closed");
  });
});
