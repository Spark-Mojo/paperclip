# Agent delegation-cycle guards

Helper: `assertNoAgentDelegationCycle` in `server/src/routes/issues.ts:7223`.
Refuses an agent assigning a child to the agent that created a still-open
ancestor in the same chain (A delegates to B, B delegates back to A).
Lookup: `svc.findOpenAncestorCreatedByAgent(parentIssueId, assigneeAgentId)`;
the creator lookup is parent-inclusive (the service CTE seeds from
`parentIssueId` itself, `server/src/services/issues.ts:8482-8484`), so a
parent created by the assignee also trips the guard, not just strict ancestors.
"Closed" means `status NOT IN ('done','cancelled')`
(`server/src/services/issues.ts:8493`); other statuses still count as open.

## 1. PATCH reassignment / reparent guard

Site: `server/src/routes/issues.ts` PATCH handler (~13462-13494).
Runs only for `actor.actorType === "agent"`:

- Reassign path (~13475): assignee changes to a new non-null agent ->
  check `(effective parent, next assignee)`.
- Reparent-only path (~13488): assignee unchanged, parent changes, issue
  already has an assignee -> check `(next parent, current assignee)`.

## 2. Accepted-plan decomposition guard

Site: `server/src/routes/issues.ts` accepted-plan decomposition loop (~12378),
per requested child: check `(sourceIssue.id, child assigneeAgentId)`.
Same helper also guards plain create (~11706) and child-create (~12122)
paths; the oracles below pin PATCH + decomposition.

## 3. `409 delegation_cycle` behavior

On a hit the route throws `conflict(...)`: HTTP 409, body error contains
`"Delegation cycle"`, `details = { code: "delegation_cycle",
ancestorIssueId, assigneeAgentId }`. The mutation is not performed
(`update` / `decomposeAcceptedPlan` not called). Guidance in the message:
finish the work in your own issue, leave the child unassigned, or escalate
to a board operator.

## 4. Allow / exempt cases (no 409)

Guard returns silently when any holds:

- Non-agent actor: board/human PATCH assignments are exempt.
- Self-assignment: `assigneeAgentId === actor.agentId` (decomposition
  into your own work is not delegation back).
- Null/empty: no parent or no assignee (includes clearing the assignee).
- No open ancestor created by the assignee (includes post-repair
  topologies where the open root creator differs from the assignee).

## 5. Oracle suite

```bash
npx vitest run server/src/__tests__/issue-assignee-invokability-routes.test.ts
```

Cases: PATCH 409 reassign (line ~362), reparent-only (~410),
reassign+reparent (~445); decomposition 409 (~494); allows: post-repair
topology (~521), board-actor exempt (~565), null-clear (~586),
self-assign (~607).
