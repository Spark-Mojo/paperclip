// .unlazy/SPA-17841/repro-keepalive.mjs
// Fixture port of the opencode v2.0.26 openai-chat provider `eie` onHalt guard
// (binary-derived, minified symbol `eie` -- NOT a file:line):
//   if (e.finishReason === void 0 && e.requireFinishReason)
//     yields zH({ message: "OpenAI Chat stream ended without finish_reason",
//                  classification: "incomplete-stream", route: w })
// with requireFinishReason defaulting true
// (e.model.compatibility?.requireFinishReason ?? !0).
//
// Run: node .unlazy/SPA-17841/repro-keepalive.mjs (no live dispatch, no fleet touch)

const EXACT = "OpenAI Chat stream ended without finish_reason";

// Minimal SSE-stream parser mirroring the guard: halt iff the stream ends
// ([DONE]) without any non-null finish_reason AND requireFinishReason is true.
function parseStream(chunks, { requireFinishReason = true } = {}) {
  let seenFinishReason = false;
  for (const chunk of chunks) {
    const line = chunk.trim();
    if (line === "data: [DONE]" || line === "[DONE]") break;
    if (line.startsWith(":")) continue; // keepalive comment chunk
    const m = line.match(/"finish_reason"\s*:\s*"([^"]+)"/);
    if (m) seenFinishReason = true;
  }
  if (!seenFinishReason && requireFinishReason) {
    return { halted: true, message: EXACT, classification: "incomplete-stream" };
  }
  return { halted: false };
}

// Case 1 (failing shape): keepalive-only prefix, data frames that never carry a
// finish_reason, then [DONE] -- the dead-transport / keepalive-only stream shape.
const keepaliveOnlyThenDone = [
  ": keepalive\n\n",
  'data: {"choices":[{"delta":{"content":""},"finish_reason":null}]}\n\n',
  ": keepalive\n\n",
  'data: {"choices":[{"delta":{},"finish_reason":null}]}\n\n',
  "data: [DONE]",
];

// Case 2 (control): a normal stream carrying finish_reason "stop" before [DONE].
const normalStopThenDone = [
  'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]",
];

const repro = parseStream(keepaliveOnlyThenDone, { requireFinishReason: true });
const control = parseStream(normalStopThenDone, { requireFinishReason: true });
const masked = parseStream(keepaliveOnlyThenDone, { requireFinishReason: false });

console.log(
  repro.halted && repro.message === EXACT
    ? `REPRODUCTION: CONFIRMED exact string "${repro.message}" on keepalive-only stream (classification: ${repro.classification})`
    : `REPRODUCTION: FAILED to reproduce (halted=${repro.halted})`,
);
console.log(
  !control.halted
    ? "CONTROL: normal stop stream does not halt (parser discriminates)"
    : "CONTROL: UNEXPECTED HALT on normal stream",
);
console.log(
  !masked.halted
    ? "MASK-CHECK: requireFinishReason:false does not halt on the same dead stream (tolerance is a mask, not a transport fix)"
    : "MASK-CHECK: UNEXPECTED HALT with requireFinishReason:false",
);

if (!(repro.halted && repro.message === EXACT && !control.halted && !masked.halted)) {
  process.exit(1);
}
