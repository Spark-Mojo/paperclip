import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Issue, IssueThreadInteraction } from "@paperclipai/shared";
import { PendingQuestionsInboxView } from "@/components/PendingQuestionsInboxView";
import { defaultIssueFilterState } from "@/lib/issue-filters";
import { queryKeys } from "@/lib/queryKeys";

const companyId = "company-storybook";

const viewDefaults = {
  issueFilters: defaultIssueFilterState,
  currentUserId: "local-board",
  liveIssueIds: new Set<string>(),
  workspaceFilterContext: {},
  showStatusColumn: true,
  showIdentifierColumn: true,
  showUpdatedColumn: true,
};

function makeInteraction(
  id: string,
  kind: string,
  status: string,
  issueId: string,
): IssueThreadInteraction {
  return {
    id,
    companyId,
    issueId,
    kind: kind as IssueThreadInteraction["kind"],
    status: status as IssueThreadInteraction["status"],
    continuationPolicy: "none",
    resolverPolicy: "board_only",
    requestedResolverPolicy: "board_only",
    effectiveResolverPolicy: "board_only",
    addresseeAgentId: null,
    title: null,
    summary: null,
    sourceCommentId: null,
    sourceRunId: null,
    idempotencyKey: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    resolvedAt: null,
  } as IssueThreadInteraction;
}

function makeIssue(
  id: string,
  identifier: string,
  title: string,
  responsibleUserId: string = "local-board",
): Issue {
  return {
    id,
    companyId,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title,
    description: null,
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: "agent-1",
    assigneeUserId: responsibleUserId,
    responsibleUserId,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    blockedInboxAttention: null,
    lastActivityAt: "2026-07-01T00:00:00.000Z",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  } as unknown as Issue;
}

// --- Populated fixtures ---

const populatedIssues: Issue[] = [
  makeIssue("pq-1", "PAP-501", "Which auth provider should we use?"),
  makeIssue("pq-2", "PAP-502", "Approve plan: onboarding redesign"),
  makeIssue("pq-3", "PAP-503", "Confirm: ship release v2"),
  makeIssue("pq-4", "PAP-504", "Answer 3 questions on migration strategy"),
  makeIssue("pq-5", "PAP-505", "Confirm rollback plan"),
];

const populatedInteractions: Record<string, IssueThreadInteraction[]> = {
  "pq-1": [makeInteraction("intx-pq-1", "ask_user_questions", "pending", "pq-1")],
  "pq-2": [makeInteraction("intx-pq-2", "request_confirmation", "pending", "pq-2")],
  "pq-3": [makeInteraction("intx-pq-3", "request_confirmation", "pending", "pq-3")],
  "pq-4": [makeInteraction("intx-pq-4", "ask_user_questions", "pending", "pq-4")],
  "pq-5": [makeInteraction("intx-pq-5", "request_confirmation", "pending", "pq-5")],
};

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } },
  });
}

/** Prime the react-query cache so the view renders deterministic data without a backend. */
function PrimePendingQuestionsFixtures({
  children,
  issues,
  interactionsByIssueId,
}: {
  children: React.ReactNode;
  issues: Issue[];
  interactionsByIssueId: Record<string, IssueThreadInteraction[]>;
}) {
  const queryClient = useQueryClient();
  useMemo(() => {
    const listKey = [...queryKeys.issues.list(companyId), "pending-questions", "assignee-local-board"];
    queryClient.setQueryData(listKey, issues);
    for (const issue of issues) {
      queryClient.setQueryData(
        queryKeys.issues.interactions(issue.id),
        interactionsByIssueId[issue.id] ?? [],
      );
    }
  }, [queryClient, issues, interactionsByIssueId]);
  return <>{children}</>;
}

function PopulatedSurface() {
  return (
    <QueryClientProvider client={makeQueryClient()}>
      <PrimePendingQuestionsFixtures
        issues={populatedIssues}
        interactionsByIssueId={populatedInteractions}
      >
        <div className="space-y-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Inbox / Pending Questions — populated
          </div>
          <div className="rounded-lg border border-border bg-background p-4">
            <PendingQuestionsInboxView
              {...viewDefaults}
              companyId={companyId}
              searchQuery=""
              issueLinkState={null}
            />
          </div>
        </div>
      </PrimePendingQuestionsFixtures>
    </QueryClientProvider>
  );
}

function EmptySurface() {
  return (
    <QueryClientProvider client={makeQueryClient()}>
      <PrimePendingQuestionsFixtures issues={[]} interactionsByIssueId={{}}>
        <div className="space-y-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Inbox / Pending Questions — empty
          </div>
          <div className="rounded-lg border border-border bg-background p-4">
            <PendingQuestionsInboxView
              {...viewDefaults}
              companyId={companyId}
              searchQuery=""
              issueLinkState={null}
            />
          </div>
        </div>
      </PrimePendingQuestionsFixtures>
    </QueryClientProvider>
  );
}

const meta = {
  title: "Product/Inbox/Pending Questions",
  component: PopulatedSurface,
  parameters: {
    docs: {
      description: {
        component:
          "Pending Questions for Me inbox tab. Shows issues with responsibleUserId = local-board that have a pending ask_user_questions or request_confirmation interaction.",
      },
    },
  },
} satisfies Meta<typeof PopulatedSurface>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  render: () => <PopulatedSurface />,
};

export const Empty: Story = {
  render: () => <EmptySurface />,
};
