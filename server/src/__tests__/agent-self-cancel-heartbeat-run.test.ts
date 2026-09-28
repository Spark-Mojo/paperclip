import { describe, expect, it } from "vitest";
import { decideCancelAuth } from "../routes/agents.js";

const agentId = "agent-self-1";
const otherAgentId = "agent-other-1";
const userId = "local-board";

describe("decideCancelAuth (SPA-9035)", () => {
  it("allows an agent to cancel its own automation-source queued run", () => {
    const decision = decideCancelAuth(
      { type: "agent", agentId },
      { agentId, invocationSource: "automation", status: "queued" },
    );
    expect(decision).toMatchObject({
      ok: true,
      cancelledByActorType: "agent",
      cancelReason: "Cancelled by the owning agent",
      activityActorType: "agent",
      activityActorId: agentId,
    });
    expect(decision.ok && decision.resultJsonPatch).toEqual({
      cancelledByActorType: "agent",
      cancelledByAgentId: agentId,
    });
  });

  it("allows an agent to cancel its own on-demand-source running run", () => {
    const decision = decideCancelAuth(
      { type: "agent", agentId },
      { agentId, invocationSource: "on_demand", status: "running" },
    );
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.cancelledByActorType).toBe("agent");
      expect(decision.resultJsonPatch.cancelledByAgentId).toBe(agentId);
    }
  });

  it("forbids an agent from cancelling another agent's automation run", () => {
    const decision = decideCancelAuth(
      { type: "agent", agentId },
      { agentId: otherAgentId, invocationSource: "automation", status: "queued" },
    );
    expect(decision).toEqual({
      ok: false,
      status: 403,
      error: "Agent can only cancel its own automation or on-demand runs",
    });
  });

  it("forbids an agent from cancelling its own timer-source run", () => {
    const decision = decideCancelAuth(
      { type: "agent", agentId },
      { agentId, invocationSource: "timer", status: "queued" },
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.status).toBe(403);
  });

  it("forbids an agent from cancelling its own assignment-source run", () => {
    const decision = decideCancelAuth(
      { type: "agent", agentId },
      { agentId, invocationSource: "assignment", status: "queued" },
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.status).toBe(403);
  });

  it("returns 409 when an agent tries to cancel an already-terminal run", () => {
    const decision = decideCancelAuth(
      { type: "agent", agentId },
      { agentId, invocationSource: "automation", status: "cancelled" },
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.status).toBe(409);
      expect(decision.error).toContain("cancelled");
    }
  });

  it("returns 409 for an automation run stuck in succeeded state", () => {
    const decision = decideCancelAuth(
      { type: "agent", agentId },
      { agentId, invocationSource: "automation", status: "succeeded" },
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.status).toBe(409);
  });

  it("allows a board user to cancel any run", () => {
    const decision = decideCancelAuth(
      { type: "user", userId },
      { agentId, invocationSource: "timer", status: "queued" },
    );
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.cancelledByActorType).toBe("user");
      expect(decision.activityActorType).toBe("user");
      expect(decision.activityActorId).toBe(userId);
      expect(decision.resultJsonPatch).toEqual({
        cancelledByActorType: "user",
        cancelledByUserId: userId,
      });
    }
  });

  it("handles a null actor.agentId gracefully (rejects)", () => {
    const decision = decideCancelAuth(
      { type: "agent", agentId: null },
      { agentId, invocationSource: "automation", status: "queued" },
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.status).toBe(403);
  });
});