import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * SPA-9259: Linux caps a single argv/env string at MAX_ARG_STRLEN (128 KiB),
 * and the ssh transport folds every env value into one `env KEY=VAL ...`
 * command string. Putting the serialized wake payload into
 * `PAPERCLIP_WAKE_PAYLOAD_JSON` unconditionally makes spawn fail with E2BIG
 * before the agent CLI ever starts (measured: 150,745-byte payload on run
 * f9824731). Payloads at or below PAPERCLIP_WAKE_PAYLOAD_INLINE_MAX_BYTES keep
 * the historical env-var path; anything larger is moved out of the
 * environment so the spawn stays viable:
 *  - local execution: written to a run-scoped file, exposed through
 *    PAPERCLIP_WAKE_PAYLOAD_FILE (+ PAPERCLIP_WAKE_PAYLOAD_BYTES);
 *  - remote execution: the JSON var is dropped (a host-local file would be
 *    unreadable on the remote box). The payload content still reaches the
 *    agent through the rendered wake prompt in the stdin prompt.
 */
export const PAPERCLIP_WAKE_PAYLOAD_INLINE_MAX_BYTES = 96 * 1024;

export const PAPERCLIP_WAKE_PAYLOAD_JSON_ENV_KEY = "PAPERCLIP_WAKE_PAYLOAD_JSON";
export const PAPERCLIP_WAKE_PAYLOAD_FILE_ENV_KEY = "PAPERCLIP_WAKE_PAYLOAD_FILE";
export const PAPERCLIP_WAKE_PAYLOAD_BYTES_ENV_KEY = "PAPERCLIP_WAKE_PAYLOAD_BYTES";

export interface PaperclipWakePayloadEnvResult {
  /** "inline" (env var used) | "file" (payload staged to disk) | "dropped" (oversized on a remote target) | "absent" (no payload). */
  mode: "inline" | "file" | "dropped" | "absent";
  /** Absolute path of the staged payload file; set only in "file" mode. */
  filePath: string | null;
  /** Serialized byte size of the payload; 0 in "absent" mode. */
  byteLength: number;
}

function readEnvDir(env: Record<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * Stage the serialized wake payload for the spawned agent process. Mutates
 * `env` in place; returns the chosen mode so callers can log the fallback.
 */
export async function applyPaperclipWakePayloadEnv(
  env: Record<string, string>,
  input: {
    runId: string;
    wakePayloadJson: string | null;
    /** True when the process runs on a remote target (ssh/sandbox) that cannot read host files. */
    executionTargetIsRemote?: boolean;
    /** Preferred staging dir for local execution (run scratch). Falls back to tmpdir. */
    scratchDir?: string | null;
  },
): Promise<PaperclipWakePayloadEnvResult> {
  const json = input.wakePayloadJson;
  const clearWakeKeys = () => {
    delete env[PAPERCLIP_WAKE_PAYLOAD_JSON_ENV_KEY];
    delete env[PAPERCLIP_WAKE_PAYLOAD_FILE_ENV_KEY];
    delete env[PAPERCLIP_WAKE_PAYLOAD_BYTES_ENV_KEY];
  };
  if (!json || json.length === 0) {
    clearWakeKeys();
    return { mode: "absent", filePath: null, byteLength: 0 };
  }

  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength <= PAPERCLIP_WAKE_PAYLOAD_INLINE_MAX_BYTES) {
    clearWakeKeys();
    env[PAPERCLIP_WAKE_PAYLOAD_JSON_ENV_KEY] = json;
    return { mode: "inline", filePath: null, byteLength };
  }

  clearWakeKeys();
  env[PAPERCLIP_WAKE_PAYLOAD_BYTES_ENV_KEY] = String(byteLength);
  if (input.executionTargetIsRemote === true) {
    // The payload content still reaches the agent through the wake prompt in
    // the stdin prompt; only the machine-readable env copy is dropped, which
    // is what keeps the remote spawn under the argv/env limit.
    return { mode: "dropped", filePath: null, byteLength };
  }

  const runSegment = input.runId.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 48) || "run";
  const baseDir =
    readEnvDir(env, ["PAPERCLIP_RUN_SCRATCH_DIR", "PAPERCLIP_SCRATCH_DIR", "TMPDIR", "TMP", "TEMP"]) ??
    input.scratchDir ??
    os.tmpdir();
  await fs.mkdir(baseDir, { recursive: true });
  const filePath = path.join(baseDir, `paperclip-wake-payload-${runSegment}.json`);
  await fs.writeFile(filePath, json, { mode: 0o600 });
  env[PAPERCLIP_WAKE_PAYLOAD_FILE_ENV_KEY] = filePath;
  return { mode: "file", filePath, byteLength };
}
