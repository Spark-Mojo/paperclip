import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { cn } from "../lib/utils";

interface StageDecisionActionsProps {
  issueId: string;
  companyId: string;
  /** "review" | "approval" — the pending stage awaiting this user's decision. */
  stageType: "review" | "approval";
  /** Whether the engine will refuse a decision PATCH without a comment. */
  commentRequired: boolean;
  className?: string;
  onResolved?: () => void;
}

/**
 * Decision verbs for an execution stage that is currently pending with the
 * signed-in board user. Approve sends { status: "done", comment } and
 * Request changes sends { status: "in_progress", comment } in ONE PATCH — the
 * engine refuses a stage decision without a same-PATCH comment
 * (issue-execution-policy: "prior comments are not considered"), which is why
 * a plain status change alone fails.
 */
export function StageDecisionActions({
  issueId,
  companyId,
  stageType,
  commentRequired,
  className,
  onResolved,
}: StageDecisionActionsProps) {
  const queryClient = useQueryClient();
  const [comment, setComment] = useState("");
  const [pendingAction, setPendingAction] = useState<"approve" | "request_changes" | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const commentEmpty = comment.trim().length === 0;
  const commentHint = commentRequired
    ? "A decision comment is required for this stage."
    : "Optional decision comment.";

  const submit = (status: "done" | "in_progress", action: "approve" | "request_changes") => {
    if (pendingAction) return;
    if (commentRequired && commentEmpty) return;
    setPendingAction(action);
    setErrorMessage(null);
    issuesApi.update(issueId, {
      status,
      ...(comment.trim().length > 0 ? { comment: comment.trim() } : {}),
    })
      .then(() => {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issueId) });
        if (companyId) {
          void queryClient.invalidateQueries({ queryKey: ["issues", companyId] });
          void queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
        }
        onResolved?.();
      })
      .catch((error: unknown) => {
        setErrorMessage(error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Unable to record the stage decision. Please try again.");
      })
      .finally(() => {
        setPendingAction(null);
      });
  };

  const pending = pendingAction !== null;

  return (
    <div className={cn("space-y-2", className)} data-testid="stage-decision-actions">
      <Textarea
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        placeholder={commentHint}
        className="min-h-16 text-sm"
        data-testid="stage-decision-comment"
        disabled={pending}
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending || (commentRequired && commentEmpty)}
          title={commentRequired && commentEmpty ? "Add a comment to request changes" : undefined}
          onClick={() => submit("in_progress", "request_changes")}
          data-testid="stage-decision-request-changes"
        >
          {pendingAction === "request_changes" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          )}
          Request changes
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={pending || (commentRequired && commentEmpty)}
          title={commentRequired && commentEmpty ? "Add a comment to approve this stage" : undefined}
          onClick={() => submit("done", "approve")}
          data-testid="stage-decision-approve"
        >
          {pendingAction === "approve" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
          )}
          Approve
        </Button>
      </div>
      {errorMessage ? (
        <p className="text-xs text-destructive" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
