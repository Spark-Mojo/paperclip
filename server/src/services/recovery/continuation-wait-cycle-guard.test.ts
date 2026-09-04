import { describe, expect, it } from "vitest";
import { partitionChildrenSafeForBlocking } from "./continuation-wait-cycle-guard.js";

describe("continuation-wait cycle guard", () => {
  const parent = "parent-1";
  const childA = { id: "child-a", identifier: "SPA-1" };
  const childB = { id: "child-b", identifier: "SPA-2" };
  const childC = { id: "child-c", identifier: "AWAITING-YOU" };

  it("keeps every child when no child blocks the parent", () => {
    const { safeChildren, excludedChildIds } = partitionChildrenSafeForBlocking(
      [childA, childB],
      [],
    );
    expect(safeChildren).toEqual([childA, childB]);
    expect(excludedChildIds).toEqual([]);
  });

  it("excludes a child whose blocks edge points at the parent (no-op slip regression)", () => {
    // Regression for the installed guard's column slip: it collected
    // `relatedIssueId` (= parent id) instead of `issueId` (= child id), so the
    // exclusion filter never matched and the cycle could still be created.
    const childBlocksParentEdgeChildIds = [parent, childB.id];
    const { safeChildren, excludedChildIds } = partitionChildrenSafeForBlocking(
      [childA, childB, childC],
      childBlocksParentEdgeChildIds,
    );
    expect(safeChildren).toEqual([childA, childC]);
    expect(excludedChildIds).toEqual([childB.id]);
  });

  it("does not treat an unrelated blocks edge as a cycle", () => {
    const { safeChildren, excludedChildIds } = partitionChildrenSafeForBlocking(
      [childA],
      ["some-other-issue"],
    );
    expect(safeChildren).toEqual([childA]);
    expect(excludedChildIds).toEqual([]);
  });

  it("handles an empty child set", () => {
    const result = partitionChildrenSafeForBlocking([], [parent]);
    expect(result.safeChildren).toEqual([]);
    expect(result.excludedChildIds).toEqual([]);
  });
});
