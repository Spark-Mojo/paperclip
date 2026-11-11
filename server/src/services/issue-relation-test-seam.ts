/**
 * TEST-ONLY injection seam for issue blocker-relation writes.
 *
 * Production code never installs a hook, so `runIssueRelationGuardTestHook`
 * is a no-op there. Tests may install a hook to run code (for example, a
 * concurrent write) at a precise point between the blocking-cycle check and
 * the relation writes in `syncBlockedByIssueIds`.
 *
 * Do not install a hook from non-test code.
 */
export type IssueRelationGuardHook = (ctx: {
  phase: "after-cycle-check";
  companyId: string;
  issueId: string;
  blockerIssueIds: string[];
}) => Promise<void> | void;

let issueRelationGuardTestHook: IssueRelationGuardHook | null = null;

/** TEST-ONLY: install (or clear with `null`) the relation guard hook. */
export function setIssueRelationGuardTestHook(hook: IssueRelationGuardHook | null): void {
  issueRelationGuardTestHook = hook;
}

/** Awaits the installed test hook, if any; otherwise returns immediately. */
export async function runIssueRelationGuardTestHook(
  ctx: Parameters<IssueRelationGuardHook>[0],
): Promise<void> {
  const hook = issueRelationGuardTestHook;
  if (!hook) return;
  await hook(ctx);
}
