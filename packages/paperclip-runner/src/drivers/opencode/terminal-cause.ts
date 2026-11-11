/**
 * Terminal cause classification for OpenCode turns (SPA-19293).
 *
 * A turn that dies mid-transport, is rejected upstream, or completes with
 * nothing must end as a failed terminal event carrying a non-empty reason and a
 * cause class. The driver puts `terminalCauseFailure(...)` into the existing
 * `turn.failed` envelope (`payload.error`); consumers (including a later
 * task-tool wrapper) read the same shape.
 */

export const TERMINAL_CAUSE_CLASSES = [
  "client-disconnect",
  "upstream-error",
  "empty-completion",
] as const;

export type TerminalCauseClass = (typeof TERMINAL_CAUSE_CLASSES)[number];

export interface TerminalCauseFailure {
  code: TerminalCauseClass;
  causeClass: TerminalCauseClass;
  recoverable: false;
  message: string;
}

const MAX_MESSAGE_LENGTH = 2000;

const DEFAULT_REASON: Record<TerminalCauseClass, string> = {
  "client-disconnect":
    "the OpenCode event stream closed before the session reached a terminal state",
  "upstream-error": "the upstream model provider rejected or failed the request",
  "empty-completion":
    "the session went idle without producing any assistant text or accepted result",
};

/**
 * Classify an OpenCode `session.error` error object. Returns `upstream-error`
 * for an APIError carrying a 5xx or 429 status; everything else (including the
 * normal MessageAbortedError control path) is unclassified (`null`).
 */
export function classifySessionError(error: unknown): TerminalCauseClass | null {
  if (typeof error !== "object" || error === null || Array.isArray(error))
    return null;
  const candidate = error as { name?: unknown; data?: unknown };
  if (candidate.name !== "APIError") return null;
  const data = candidate.data;
  if (typeof data !== "object" || data === null) return null;
  const status = (data as { statusCode?: unknown }).statusCode;
  if (typeof status !== "number" || !Number.isInteger(status)) return null;
  return status === 429 || (status >= 500 && status <= 599)
    ? "upstream-error"
    : null;
}

/** Build the non-recoverable `turn.failed` error for a cause class. */
export function terminalCauseFailure(
  cause: TerminalCauseClass,
  detail?: string,
): TerminalCauseFailure {
  const trimmed = typeof detail === "string" ? detail.trim() : "";
  const message = `${cause}: ${trimmed || DEFAULT_REASON[cause]}`.slice(
    0,
    MAX_MESSAGE_LENGTH,
  );
  return { code: cause, causeClass: cause, recoverable: false, message };
}
