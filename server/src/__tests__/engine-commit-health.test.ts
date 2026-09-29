import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { healthRoutes } from "../routes/health.js";
import { createServerInfoSnapshot } from "../server-info.js";
import { readInstalledGitCommit } from "../installed-git-commit.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("engine commit health", () => {
  it("keeps the running build commit distinct from a later install", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "paperclip-engine-commit-"));
    dirs.push(home);
    const cli = path.join(home, "cli");
    mkdirSync(cli);
    const running = "a".repeat(40);
    const installed = "b".repeat(40);
    const manifest = path.join(cli, "install.json");
    writeFileSync(manifest, JSON.stringify({ source: "git", sha: running, payloadPath: "/install/a" }));
    const snapshot = createServerInfoSnapshot({ buildCommitCommand: () => running, gitCommand: () => { throw new Error("no git"); } });
    const app = express();
    app.use("/api/health", healthRoutes(undefined, {
      deploymentMode: "authenticated", deploymentExposure: "private", authReady: true,
      companyDeletionEnabled: true, serverInfo: snapshot, installedCommitPath: manifest,
    }));
    const first = await request(app).get("/api/health").expect(200);
    expect(first.body).toMatchObject({ commit: running, installedCommit: running });
    writeFileSync(manifest, JSON.stringify({ source: "git", sha: installed, payloadPath: "/install/b" }));
    const second = await request(app).get("/api/health").expect(200);
    expect(second.body).toMatchObject({ commit: running, installedCommit: installed });
  });

  it("does not infer a commit from an invalid or non-git manifest", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "paperclip-engine-commit-"));
    dirs.push(home);
    const manifest = path.join(home, "install.json");
    expect(readInstalledGitCommit(manifest)).toBeNull();
    writeFileSync(manifest, JSON.stringify({ source: "npm", sha: "a".repeat(40) }));
    expect(readInstalledGitCommit(manifest)).toBeNull();
    writeFileSync(manifest, JSON.stringify({ source: "git", sha: "invalid" }));
    expect(readInstalledGitCommit(manifest)).toBeNull();
  });
});
