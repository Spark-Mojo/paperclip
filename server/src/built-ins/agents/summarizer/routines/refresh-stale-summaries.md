---
routineKey: refresh-stale-summaries
title: Refresh stale summary slots
description: Bounded, paused-by-default sweep that kicks a fresh generation for summary slots whose underlying scope has changed since the last revision. Spends no tokens until an operator enables its schedule or runs it manually. Read-and-report only — it never mutates issues, workspaces, or code.
assigneeRef:
  resourceKind: agent
  resourceKey: summarizer
status: paused
priority: medium
concurrencyPolicy: coalesce_if_active
catchUpPolicy: skip_missed
variables:
  - name: staleAfterHours
    label: Refresh slots older than (hours)
    type: number
    defaultValue: 24
    required: false
    options: []
  - name: maxSlots
    label: Max slots to refresh per run
    type: number
    defaultValue: 10
    required: false
    options: []
  - name: scopeKinds
    label: Scope kinds to include
    type: select
    defaultValue: all
    required: false
    options:
      - all
      - project
      - workspaces_overview
      - project_workspace
triggers:
  - kind: schedule
    label: Daily stale-summary refresh
    enabled: false
    cronExpression: "0 8 * * *"
    timezone: UTC
    signingMode: none
    replayWindowSec: 0
issueTemplate:
  surfaceVisibility: normal
---

# Refresh stale summary slots

This routine is **paused by default** and spends no tokens until an operator enables its schedule or triggers a manual run. The first release of the Summarizer is manual-generation-first; this routine exists so operators can opt into scheduled refreshes without background spend by default.

## What this run must do

1. Select summary slots whose scope has changed since their last revision and whose `lastGeneratedAt` is older than `{{staleAfterHours}}` hours. Restrict to `{{scopeKinds}}` when a specific kind is chosen. Cap the set at `{{maxSlots}}`, most-stale first.
2. For each selected slot, **kick a fresh generation — do not write the slot yourself.** You are the Summarizer built-in agent, so the generate endpoint admits your agent token:
   `POST /api/companies/{companyId}/summary-slots/{scopeKind}/{slotKey}/generate` with `{ "scopeId": ... }` in the JSON body (omit `scopeId` for `workspaces_overview`). This creates the linked generation task, marks the slot `generating`, and wakes a fresh Summarizer run on that task. That generation-task run does the read-triage-write loop (via the `summarize-status` skill) and writes the revision under the engine's linked-task guard.
3. Treat a `200` response with `alreadyGenerating: true` as a clean skip — a generation is already in flight for that slot; report it as "already in flight", not as an error.
4. Skip slots with no meaningful change since their last revision — do not spend tokens requesting a regeneration of an unchanged scope.

## Hard limits for this routine

- Read-and-report only, except the single kick call per stale slot. This routine must never change issues, workspaces, code, or agent configuration, and must never write a summary revision directly — slot writes happen only inside the linked generation task.
- Keep every read company-scoped. Do not cross company boundaries.
- Run on the low-cost model profile lane (`cheap`). Keep each report short.
- Never fabricate status and never surface secrets from issue bodies or configs.

## Output

A single bounded routine issue that links the slots kicked this run, plus a summary comment listing: slots queued for generation (with their generation-task ids), slots reported already in flight, slots skipped as unchanged, and any slot that could not be read or kicked (with the unblock owner).
