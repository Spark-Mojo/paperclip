import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type ReadTextFile = (path: string) => string;

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const DEFAULT_BUILD_COMMIT_PATH = fileURLToPath(
  new URL("../../.paperclip-build-commit", import.meta.url),
);
const BUILD_STAMP_PATH = fileURLToPath(new URL("./build-info.json", import.meta.url));

function readBootBuildStamp(): string | null {
  try {
    const stamp = JSON.parse(readFileSync(BUILD_STAMP_PATH, "utf8")) as { commit?: unknown };
    return typeof stamp.commit === "string" ? parseBuildCommit(stamp.commit) : null;
  } catch {
    return null;
  }
}

export const bootBuildCommit = readBootBuildStamp();

export function parseBuildCommit(value: string | null | undefined): string | null {
  const commit = value?.trim() ?? "";
  return FULL_SHA_RE.test(commit) ? commit.toLowerCase() : null;
}

export function readBuildCommit(
  opts: {
    environmentCommit?: string | null;
    buildCommitPath?: string;
    readTextFile?: ReadTextFile;
  } = {},
): string | null {
  const environmentCommit = parseBuildCommit(
    opts.environmentCommit === undefined
      ? process.env.PAPERCLIP_BUILD_COMMIT
      : opts.environmentCommit,
  );
  if (environmentCommit) return environmentCommit;

  try {
    const readTextFile = opts.readTextFile ?? ((path: string) => readFileSync(path, "utf8"));
    return parseBuildCommit(readTextFile(opts.buildCommitPath ?? DEFAULT_BUILD_COMMIT_PATH));
  } catch {
    return null;
  }
}
