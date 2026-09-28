import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_RUN_SCRATCH_MARKER,
  RUN_SCRATCH_ORPHAN_MAX_AGE_MS,
  prepareHeartbeatRunScratch,
  sweepOrphanedRunScratch,
} from "../services/run-scratch.js";

async function writeScratchMarker(dir: string, input: {
  runId: string;
  createdAt?: string;
}) {
  await fs.writeFile(
    path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER),
    `${JSON.stringify({
      version: 1,
      companyId: randomUUID(),
      agentId: randomUUID(),
      runId: input.runId,
      issueId: null,
      issueIdentifier: null,
      createdAt: input.createdAt ?? new Date().toISOString(),
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function listRunScratchDirs(root: string) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("paperclip-run-"))
    .map((entry) => path.join(root, entry.name))
    .sort();
}

describe("sweepOrphanedRunScratch (SPA-9270)", () => {
  it("kills a surviving process group and removes the scratch dir of a terminal run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "run-scratch-sweep-test-"));
    const runId = randomUUID();
    const killed: number[] = [];
    const dir = path.join(root, "paperclip-run-test-terminal");
    await fs.mkdir(dir, { recursive: true });
    await writeScratchMarker(dir, { runId });
    await fs.writeFile(path.join(dir, "leftover.log"), "test\n");

    const result = await sweepOrphanedRunScratch({
      tmpRoot: root,
      isProcessGroupAlive: (pgid) => pgid === 4242,
      killProcessGroup: (pgid) => killed.push(pgid),
      loadRun: async () => ({
        status: "cancelled",
        processGroupId: 4242,
        processPid: 4242,
      }),
    });

    expect(result).toEqual({
      swept: 1,
      killedProcessGroups: 1,
      removedDirs: 1,
      skipped: 0,
      errors: 0,
    });
    expect(killed).toEqual([4242]);
    await expect(listRunScratchDirs(root)).resolves.toEqual([]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("removes the scratch dir of a run whose row is missing entirely", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "run-scratch-sweep-test-"));
    const runId = randomUUID();
    const dir = path.join(root, "paperclip-run-test-missing");
    await fs.mkdir(dir, { recursive: true });
    await writeScratchMarker(dir, { runId });

    const result = await sweepOrphanedRunScratch({
      tmpRoot: root,
      loadRun: async () => null,
    });

    expect(result.removedDirs).toBe(1);
    expect(result.killedProcessGroups).toBe(0);
    await expect(listRunScratchDirs(root)).resolves.toEqual([]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("never touches a live (running) run's scratch dir or its process group", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "run-scratch-sweep-test-"));
    const runId = randomUUID();
    const dir = path.join(root, "paperclip-run-test-live");
    await fs.mkdir(dir, { recursive: true });
    await writeScratchMarker(dir, { runId });

    const result = await sweepOrphanedRunScratch({
      tmpRoot: root,
      isProcessGroupAlive: (pgid) => pgid === 7777,
      killProcessGroup: () => {
        throw new Error("must not kill a live run's process group");
      },
      loadRun: async () => ({
        status: "running",
        processGroupId: 7777,
        processPid: 7777,
      }),
    });

    expect(result.skipped).toBe(1);
    expect(result.removedDirs).toBe(0);
    expect(result.killedProcessGroups).toBe(0);
    await expect(listRunScratchDirs(root)).resolves.toEqual([dir]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("skips directories without a scratch marker", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "run-scratch-sweep-test-"));
    const dir = path.join(root, "paperclip-run-not-ours");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "data.txt"), "unrelated\n");

    const result = await sweepOrphanedRunScratch({
      tmpRoot: root,
      loadRun: async () => null,
    });

    expect(result.skipped).toBe(1);
    expect(result.removedDirs).toBe(0);
    await expect(fs.stat(path.join(dir, "data.txt"))).resolves.toBeTruthy();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reclaims a running run's dir only once the marker ages past the orphan bound", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "run-scratch-sweep-test-"));
    const runId = randomUUID();
    const dir = path.join(root, "paperclip-run-test-aged");
    await fs.mkdir(dir, { recursive: true });
    const agedCreatedAt = new Date(
      Date.now() - (RUN_SCRATCH_ORPHAN_MAX_AGE_MS + 60_000),
    ).toISOString();
    await writeScratchMarker(dir, { runId, createdAt: agedCreatedAt });

    // Aged out even though the (stale) row still says running.
    const result = await sweepOrphanedRunScratch({
      tmpRoot: root,
      loadRun: async () => ({
        status: "running",
        processGroupId: null,
        processPid: null,
      }),
    });
    expect(result.removedDirs).toBe(1);
    await expect(listRunScratchDirs(root)).resolves.toEqual([]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("coexists with prepareHeartbeatRunScratch naming and cleans up its own fixture", async () => {
    const scratch = await prepareHeartbeatRunScratch({
      companyId: randomUUID(),
      agentId: randomUUID(),
      runId: randomUUID(),
      issueId: null,
      issueIdentifier: null,
    });
    expect(path.basename(scratch.dir).startsWith("paperclip-run-")).toBe(true);
    await fs.rm(scratch.dir, { recursive: true, force: true });
  });
});
