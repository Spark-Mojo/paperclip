import { readFileSync } from "node:fs";
import path from "node:path";
import { resolvePaperclipHomeDir } from "@paperclipai/shared/home-paths";
import { parseBuildCommit } from "./build-commit.js";

export function readInstalledGitCommit(manifestPath = path.join(resolvePaperclipHomeDir(), "cli", "install.json")): string | null {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { source?: unknown; sha?: unknown };
    return manifest.source === "git" && typeof manifest.sha === "string"
      ? parseBuildCommit(manifest.sha)
      : null;
  } catch {
    return null;
  }
}
