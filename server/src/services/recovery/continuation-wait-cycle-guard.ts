export type ContinuationWaitChild = { id: string; identifier: string | null };

/**
 * SPA-6057: cycle guard for the AWAITING-YOU shape in
 * `resolveContinuationWaitingOnReview`. When a blocked parent is being parked on
 * its open children, a child that already has a `blocks` edge *into* the parent
 * (edge: issueId = child, relatedIssueId = parent) would create a parent<->child
 * `blockedBy` cycle if the parent then blocked on that child — the shape that made
 * the fleet-wide recovery pass abort (SPA-5458). Those children are excluded; they
 * are already on the parent's blocker side, so the wait is still live through them.
 */
export function partitionChildrenSafeForBlocking(
  openChildren: ContinuationWaitChild[],
  childBlocksParentEdgeChildIds: Iterable<string>,
): { safeChildren: ContinuationWaitChild[]; excludedChildIds: string[] } {
  const cycleChildIds = new Set(childBlocksParentEdgeChildIds);
  const safeChildren: ContinuationWaitChild[] = [];
  const excludedChildIds: string[] = [];
  for (const child of openChildren) {
    if (cycleChildIds.has(child.id)) {
      excludedChildIds.push(child.id);
    } else {
      safeChildren.push(child);
    }
  }
  return { safeChildren, excludedChildIds };
}
