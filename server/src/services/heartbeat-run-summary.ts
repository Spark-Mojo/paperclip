export const HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS = 500;
export const HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS = 4_096;
export const HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES = 64 * 1024;

function truncateSummaryText(value: unknown, maxLength = HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS) {
  if (typeof value !== "string") return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function readNumericField(record: Record<string, unknown>, key: string) {
  return key in record ? record[key] ?? null : undefined;
}

function readCommentText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function mergeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
  summary: string | null | undefined,
): Record<string, unknown> | null {
  const normalizedSummary = readCommentText(summary);
  const baseResult =
    resultJson && typeof resultJson === "object" && !Array.isArray(resultJson)
      ? resultJson
      : null;

  if (!baseResult) {
    return normalizedSummary ? { summary: normalizedSummary } : null;
  }

  if (!normalizedSummary) {
    return baseResult;
  }

  if (readCommentText(baseResult.summary)) {
    return baseResult;
  }

  return {
    ...baseResult,
    summary: normalizedSummary,
  };
}

export function summarizeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  const summary: Record<string, unknown> = {};
  const textFields = ["summary", "result", "message", "error"] as const;
  for (const key of textFields) {
    const value = truncateSummaryText(resultJson[key]);
    if (value !== null) {
      summary[key] = value;
    }
  }

  const numericFieldAliases = ["total_cost_usd", "cost_usd", "costUsd"] as const;
  for (const key of numericFieldAliases) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["stopReason", "timeoutSource"] as const) {
    const value = readCommentText(resultJson[key]);
    if (value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["effectiveTimeoutSec", "effectiveTimeoutMs"] as const) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["timeoutConfigured", "timeoutFired"] as const) {
    if (typeof resultJson[key] === "boolean") {
      summary[key] = resultJson[key];
    }
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

export const MAX_FALLBACK_COMMENT_CHARS = 1200;
// Apostrophes are matched as a character class so both the straight (') and
// curly (’) forms count — agents emit either. Openers are narration phrases a
// declarative status summary would not begin with ("Fixed X", "13/13 pass").
const NARRATION_OPENERS =
  /^(let me\b|i['’]ll\b|i['’]m going\b|i need to\b|i can see\b|now i['’]ll\b|next,? i['’]ll\b|looking at\b|fetching\b|checking\b|first,)/i;
// SPA-8089: litellm rewrites empty assistant text parts to a filler string
// ("[System: Empty message content sanitised to satisfy protocol]") so the
// provider accepts them, and the adapter concatenates every text part into
// `summary`. A run whose model emitted only empty text (or empty text plus a
// leaked tool-call serialization) then yields a summary that is placeholder
// soup, not a verdict. Posting it verbatim corrupts the board thread and can
// masquerade as a reviewer decision artifact. Withhold it like narration.
const EMPTY_MESSAGE_PLACEHOLDER = "Empty message content sanitised to satisfy protocol";
// Leaked harness/provider tool-call serialization fragments. Matched loosely on
// purpose: wire formats vary (minimax function_calls.js, invoke_ash, tool_call
// closers, intra-turn parameter/workdir markers), but none of these tokens ever
// appear in a genuine declarative status summary ("Fixed X", "13/13 pass").
const TOOL_CALL_SERIALIZATION_MARKERS =
  /function_calls\.js|invoke_ash|<\/?tool_call|<parameter name=|<workdir>|stalledReviewDecisionSchema|<\]\w+\[>|\[<]?\/?command[>\]]/i;
const FALLBACK_WITHHELD_COMMENT =
  "Run completed. Agent did not post a summary comment this run (transcript withheld — see run log).";

function isPlaceholderSoupText(text: string): boolean {
  if (text.includes(EMPTY_MESSAGE_PLACEHOLDER)) return true;
  // Tool-call serialization is never a summary on its own. It only counts as
  // soup when the text carries no natural-language sentence: strip
  // bracket/tag markup, paths, and non-letters, then require at least three
  // 4+ letter words. The serialization shape strips to fragments like
  // "server src"; a genuine summary mentioning a tool ("verified with grep
  // that no stale route remains") keeps its sentence and still posts.
  if (!TOOL_CALL_SERIALIZATION_MARKERS.test(text)) return false;
  const stripped = text
    .replace(/\[.+?\]/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\b\w*\/\w[\w/.-]*\b/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && /^\p{L}+$/u.test(w));
  return stripped.length < 3;
}

export function buildHeartbeatRunIssueComment(
  resultJson: Record<string, unknown> | null | undefined,
): string | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  const text =
    readCommentText(resultJson.summary)
    ?? readCommentText(resultJson.result)
    ?? readCommentText(resultJson.message);
  if (!text) {
    return null;
  }

  if (
    text.length > MAX_FALLBACK_COMMENT_CHARS
    || NARRATION_OPENERS.test(text.trimStart())
    || isPlaceholderSoupText(text)
  ) {
    return FALLBACK_WITHHELD_COMMENT;
  }

  return text;
}
