// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, IssueThreadInteraction } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listInteractions: vi.fn(),
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    className,
    disableIssueQuicklook: _disableIssueQuicklook,
    issuePrefetch: _issuePrefetch,
    ...props
  }: React.ComponentProps<"a"> & { disableIssueQuicklook?: boolean; issuePrefetch?: Issue | null }) => (
    <a className={className} {...props}>
      {children}
    </a>
  ),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> | undefined;
  flushSync(() => {
    result = callback();
  });
  return result;
}

import { PendingQuestionsInboxView } from "./PendingQuestionsInboxView";
import { defaultIssueFilterState } from "../lib/issue-filters";

function makeInteraction(
  id: string,
  kind: string,
  status: string,
  issueId: string,
): IssueThreadInteraction {
  return {
    id,
    companyId: "company-1",
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
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
    resolvedAt: null,
  } as IssueThreadInteraction;
}

function makeIssue(
  id: string,
  identifier: string,
  title: string,
  responsibleUserId: string,
): Issue {
  return {
    id,
    companyId: "company-1",
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
    lastActivityAt: "2026-05-09T00:00:00.000Z",
    createdAt: new Date("2026-05-09T00:00:00.000Z"),
    updatedAt: new Date("2026-05-09T00:00:00.000Z"),
  } as unknown as Issue;
}

function renderWithClient(node: React.ReactNode, container: HTMLDivElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });
  return { root, queryClient };
}

const pendingViewProps = {
  companyId: "company-1",
  searchQuery: "",
  issueLinkState: null,
  issueFilters: defaultIssueFilterState,
  currentUserId: "local-board",
  liveIssueIds: new Set<string>(),
  workspaceFilterContext: {},
  showStatusColumn: true,
  showIdentifierColumn: true,
  showUpdatedColumn: true,
};

async function waitFor(predicate: () => boolean, attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error("waitFor predicate did not become true");
}

describe("PendingQuestionsInboxView", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockIssuesApi.list.mockReset();
    mockIssuesApi.listInteractions.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  it("renders only issues with pending ask_user_questions or request_confirmation interactions", async () => {
    // 3 issues all with responsibleUserId = "local-board"
    const issues: Issue[] = [
      makeIssue("issue-match-questions", "PAP-1", "Answer rollout questions", "local-board"),
      makeIssue("issue-match-confirmation", "PAP-2", "Confirm deployment plan", "local-board"),
      makeIssue("issue-no-pending", "PAP-3", "Already answered", "local-board"),
    ];
    mockIssuesApi.list.mockResolvedValue(issues);

    // issue-match-questions: pending ask_user_questions -> MATCH
    // issue-match-confirmation: pending request_confirmation -> MATCH
    // issue-no-pending: only an answered ask_user_questions -> NO MATCH
    mockIssuesApi.listInteractions.mockImplementation((issueId: string) => {
      if (issueId === "issue-match-questions") {
        return Promise.resolve([
          makeInteraction("intx-1", "ask_user_questions", "pending", issueId),
        ]);
      }
      if (issueId === "issue-match-confirmation") {
        return Promise.resolve([
          makeInteraction("intx-2", "request_confirmation", "pending", issueId),
        ]);
      }
      // issue-no-pending: answered (not pending)
      return Promise.resolve([
        makeInteraction("intx-3", "ask_user_questions", "answered", issueId),
      ]);
    });

    const { root } = renderWithClient(
      <PendingQuestionsInboxView
        {...pendingViewProps}
      />,
      container,
    );

    await waitFor(() => container.querySelectorAll('[data-testid="pending-questions-inbox"] a').length === 2);

    const titles = Array.from(container.querySelectorAll("a")).map((a) => a.textContent ?? "");
    expect(titles.some((t) => t.includes("Answer rollout questions"))).toBe(true);
    expect(titles.some((t) => t.includes("Confirm deployment plan"))).toBe(true);
    expect(titles.some((t) => t.includes("Already answered"))).toBe(false);

    act(() => root.unmount());
  });

  it("shows the empty state when no issues match", async () => {
    mockIssuesApi.list.mockResolvedValue([]);

    const { root } = renderWithClient(
      <PendingQuestionsInboxView
        {...pendingViewProps}
      />,
      container,
    );

    await waitFor(() => container.querySelector('[data-testid="pending-questions-empty"]') !== null);
    const emptyState = container.querySelector('[data-testid="pending-questions-empty"]');
    expect(emptyState).not.toBeNull();
    expect(emptyState?.textContent).toContain("Nothing needs your decision right now");

    act(() => root.unmount());
  });

  it("filters out issues whose responsibleUserId is not local-board", async () => {
    const issues: Issue[] = [
      makeIssue("issue-board", "PAP-1", "Board question", "local-board"),
      makeIssue("issue-user-2", "PAP-2", "User 2 question", "user-2"),
    ];
    mockIssuesApi.list.mockResolvedValue(issues);

    mockIssuesApi.listInteractions.mockImplementation((issueId: string) => {
      return Promise.resolve([
        makeInteraction(`intx-${issueId}`, "ask_user_questions", "pending", issueId),
      ]);
    });

    const { root } = renderWithClient(
      <PendingQuestionsInboxView
        {...pendingViewProps}
      />,
      container,
    );

    await waitFor(() => container.querySelectorAll('[data-testid="pending-questions-inbox"] a').length === 1);

    const titles = Array.from(container.querySelectorAll("a")).map((a) => a.textContent ?? "");
    expect(titles.some((t) => t.includes("Board question"))).toBe(true);
    expect(titles.some((t) => t.includes("User 2 question"))).toBe(false);

    act(() => root.unmount());
  });

  it("filters out issues whose only pending interaction is kind comment (not in allowed set)", async () => {
    const issues: Issue[] = [
      makeIssue("issue-allowed", "PAP-1", "Allowed question", "local-board"),
      makeIssue("issue-comment-only", "PAP-2", "Comment only", "local-board"),
    ];
    mockIssuesApi.list.mockResolvedValue(issues);

    mockIssuesApi.listInteractions.mockImplementation((issueId: string) => {
      if (issueId === "issue-allowed") {
        return Promise.resolve([
          makeInteraction("intx-ok", "ask_user_questions", "pending", issueId),
        ]);
      }
      // issue-comment-only: pending but kind is not in the allowed set.
      // "comment" is not a valid IssueThreadInteractionKind, but we cast to test the filter.
      return Promise.resolve([
        makeInteraction("intx-comment", "comment", "pending", issueId),
      ]);
    });

    const { root } = renderWithClient(
      <PendingQuestionsInboxView
        {...pendingViewProps}
      />,
      container,
    );

    await waitFor(() => container.querySelectorAll('[data-testid="pending-questions-inbox"] a').length === 1);

    const titles = Array.from(container.querySelectorAll("a")).map((a) => a.textContent ?? "");
    expect(titles.some((t) => t.includes("Allowed question"))).toBe(true);
    expect(titles.some((t) => t.includes("Comment only"))).toBe(false);

    act(() => root.unmount());
  });
});
