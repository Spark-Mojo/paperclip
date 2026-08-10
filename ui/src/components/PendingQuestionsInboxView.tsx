import { useMemo } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { Issue, IssueThreadInteraction } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { applyIssueFilters, type IssueFilterState, type IssueFilterWorkspaceContext } from "../lib/issue-filters";
import { IssueGroupHeader } from "./IssueGroupHeader";
import { IssueRow } from "./IssueRow";
import { StatusIcon } from "./StatusIcon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const PENDING_QUESTIONS_LIST_LIMIT = 200;
const PENDING_INTERACTION_KINDS = new Set(["ask_user_questions", "request_confirmation"]);
const LOCAL_BOARD_RESPONSIBLE_USER_ID = "local-board";

interface PendingQuestionsInboxViewProps {
  companyId: string;
  searchQuery: string;
  issueLinkState: unknown;
  issueFilters: IssueFilterState;
  currentUserId: string | null;
  liveIssueIds: ReadonlySet<string>;
  workspaceFilterContext: IssueFilterWorkspaceContext;
  showStatusColumn: boolean;
  showIdentifierColumn: boolean;
  showUpdatedColumn: boolean;
}

interface PendingQuestionsRow {
  issue: Issue;
  latestPendingInteraction: IssueThreadInteraction | null;
}

function interactionIsPendingMatch(interaction: IssueThreadInteraction): boolean {
  return interaction.status === "pending" && PENDING_INTERACTION_KINDS.has(interaction.kind);
}

function buildPendingQuestionsRows(issues: Issue[]): PendingQuestionsRow[] {
  const rows: PendingQuestionsRow[] = [];
  for (const issue of issues) {
    if (issue.responsibleUserId !== LOCAL_BOARD_RESPONSIBLE_USER_ID) continue;
    rows.push({ issue, latestPendingInteraction: null });
  }
  return rows;
}

function sortRowsByMostRecentActivity(rows: PendingQuestionsRow[]): PendingQuestionsRow[] {
  return [...rows].sort((a, b) => {
    const aTime = a.issue.lastActivityAt
      ? new Date(a.issue.lastActivityAt).getTime()
      : new Date(a.issue.updatedAt).getTime();
    const bTime = b.issue.lastActivityAt
      ? new Date(b.issue.lastActivityAt).getTime()
      : new Date(b.issue.updatedAt).getTime();
    return bTime - aTime;
  });
}

function rowMatchesSearch(row: PendingQuestionsRow, searchQuery: string): boolean {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return true;
  const { issue } = row;
  if (issue.title?.toLowerCase().includes(q)) return true;
  if (issue.identifier?.toLowerCase().includes(q)) return true;
  if (issue.description?.toLowerCase().includes(q)) return true;
  return false;
}

export function PendingQuestionsInboxView({
  companyId,
  searchQuery,
  issueLinkState,
  issueFilters,
  currentUserId,
  liveIssueIds,
  workspaceFilterContext,
  showStatusColumn,
  showIdentifierColumn,
  showUpdatedColumn,
}: PendingQuestionsInboxViewProps) {
  const {
    data: issues = [] as Issue[],
    isLoading,
    isFetching,
    error,
    refetch,
  } = useQuery({
    queryKey: [...queryKeys.issues.list(companyId), "pending-questions", "assignee-local-board"],
    queryFn: () =>
      issuesApi.list(companyId, {
        assigneeUserId: LOCAL_BOARD_RESPONSIBLE_USER_ID,
        limit: PENDING_QUESTIONS_LIST_LIMIT,
      }),
  });

  // Fan out per-issue interactions fetches using useQueries for dedup + parallelism.
  const interactionQueries = useQueries({
    queries: issues.map((issue) => ({
      queryKey: queryKeys.issues.interactions(issue.id),
      queryFn: () => issuesApi.listInteractions(issue.id),
    })),
  });

  // Build a map of issueId -> has-pending-match so we can filter on the client side.
  const issueIdsWithPendingInteraction = useMemo(() => {
    const matchSet = new Set<string>();
    interactionQueries.forEach((result, index) => {
      const issue = issues[index];
      if (!issue || !result.data) return;
      if (result.data.some(interactionIsPendingMatch)) {
        matchSet.add(issue.id);
      }
    });
    return matchSet;
  }, [interactionQueries, issues]);

  const allRows = useMemo(() => buildPendingQuestionsRows(issues), [issues]);
  const interactionFilteredRows = useMemo(
    () => allRows.filter((row) => issueIdsWithPendingInteraction.has(row.issue.id)),
    [allRows, issueIdsWithPendingInteraction],
  );
  const searchFilteredRows = useMemo(
    () => interactionFilteredRows.filter((row) => rowMatchesSearch(row, searchQuery)),
    [interactionFilteredRows, searchQuery],
  );

  const issueFilteredRows = useMemo(() => {
    const visibleIssueIds = new Set(
      applyIssueFilters(
        searchFilteredRows.map((row) => row.issue),
        issueFilters,
        currentUserId,
        true,
        liveIssueIds,
        workspaceFilterContext,
      ).map((issue) => issue.id),
    );
    return searchFilteredRows.filter((row) => visibleIssueIds.has(row.issue.id));
  }, [searchFilteredRows, issueFilters, currentUserId, liveIssueIds, workspaceFilterContext]);

  const sortedRows = useMemo(() => sortRowsByMostRecentActivity(issueFilteredRows), [issueFilteredRows]);

  const interactionsLoading = interactionQueries.some((q) => q.isLoading);
  const interactionsFetching = interactionQueries.some((q) => q.isFetching);

  if (isLoading || interactionsLoading) {
    return (
      <div data-testid="pending-questions-loading" className="space-y-3" aria-busy="true">
        {Array.from({ length: 3 }).map((_, groupIdx) => (
          <div key={groupIdx} className="space-y-1">
            <div className="h-4 w-40 animate-pulse rounded bg-muted/70" />
            {Array.from({ length: 2 }).map((__, rowIdx) => (
              <div
                key={rowIdx}
                className="flex items-center gap-3 border-b border-border/60 px-3 py-2.5 sm:px-4"
              >
                <div className="h-3.5 w-3.5 animate-pulse rounded-full bg-muted" />
                <div className="h-4 w-16 animate-pulse rounded bg-muted/70" />
                <div className="h-4 w-32 animate-pulse rounded-md bg-muted/70" />
                <div className="h-4 flex-1 animate-pulse rounded bg-muted/60" />
                <div className="hidden h-3 w-24 animate-pulse rounded bg-muted/60 sm:block" />
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    const message =
      error instanceof Error ? error.message : "Couldn't load the Pending Questions tab.";
    return (
      <div
        data-testid="pending-questions-error"
        role="alert"
        className="flex flex-col gap-2 rounded-md border border-amber-300/70 bg-amber-50/90 p-4 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
      >
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="flex-1 space-y-1">
            <p className="text-sm font-medium">Couldn't load the Pending Questions tab.</p>
            <p className="text-xs opacity-80">
              Other Inbox tabs still work. {message}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 shrink-0 border-amber-400/70 bg-white/40 text-amber-900 hover:bg-white/70 dark:bg-amber-500/20 dark:text-amber-100"
            onClick={() => void refetch()}
            disabled={isFetching || interactionsFetching}
          >
            {isFetching ? "Trying…" : "Try again"}
          </Button>
        </div>
      </div>
    );
  }

  if (allRows.length === 0) {
    return (
      <Card
        data-testid="pending-questions-empty"
        className="items-center gap-3 border-border/70 bg-card/40 px-6 py-10 text-center"
      >
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
          <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">Nothing needs your decision right now</p>
          <p className="text-xs text-muted-foreground">
            Issues with pending questions or confirmation requests from the board will appear here.
          </p>
        </div>
      </Card>
    );
  }

  if (sortedRows.length === 0) {
    return (
      <div className="space-y-3">
        <Card
          data-testid="pending-questions-no-search-results"
          className="block border-border/70 bg-card/40 px-4 py-6 text-center text-sm text-muted-foreground"
        >
          {interactionFilteredRows.length === 0
            ? "Nothing needs your decision right now."
            : "No pending questions match your search."}
        </Card>
      </div>
    );
  }

  return (
    <div data-testid="pending-questions-inbox" className="space-y-3">
      <div className="overflow-hidden rounded-xl">
        <div className="px-3 sm:px-4">
          <IssueGroupHeader
            label={`Pending questions · ${sortedRows.length}`}
          />
        </div>
        <div>
          {sortedRows.map((row) => (
            <PendingQuestionsRow
              key={row.issue.id}
              row={row}
              issueLinkState={issueLinkState}
              showStatusColumn={showStatusColumn}
              showIdentifierColumn={showIdentifierColumn}
              showUpdatedColumn={showUpdatedColumn}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface PendingQuestionsRowProps {
  row: PendingQuestionsRow;
  issueLinkState: unknown;
  showStatusColumn: boolean;
  showIdentifierColumn: boolean;
  showUpdatedColumn: boolean;
}

function PendingQuestionsRow({
  row,
  issueLinkState,
  showStatusColumn,
  showIdentifierColumn,
  showUpdatedColumn: _showUpdatedColumn,
}: PendingQuestionsRowProps) {
  const { issue } = row;
  const identifier = issue.identifier ?? issue.id.slice(0, 8);

  return (
    <IssueRow
      issue={issue}
      issueLinkState={issueLinkState}
      showDivider
      desktopMetaLeading={
        <span className="hidden shrink-0 items-center gap-2 sm:inline-flex">
          {showStatusColumn ? <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention ?? null} /> : null}
          {showIdentifierColumn ? (
            <span className="font-mono text-xs text-muted-foreground">{identifier}</span>
          ) : null}
        </span>
      }
      mobileLeading={
        <span className="flex shrink-0 items-center gap-1.5 pt-px">
          <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention ?? null} />
        </span>
      }
    />
  );
}
