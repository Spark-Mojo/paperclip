import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runChildProcess } from "./server-utils.js";

const fixture = `const fs=require('fs');const {spawn}=require('child_process');const group=fs.readFileSync('/proc/self/cgroup','utf8').trim().split(':').at(-1);const root='/sys/fs/cgroup'+group;const children=[];let failed=0;for(let i=0;i<24;i++){try{const child=spawn('/bin/sleep',['3'],{stdio:'ignore'});child.on('error',()=>{});if(child.pid)children.push(child);else failed++;}catch{failed++;}}const events=fs.readFileSync(root+'/pids.events','utf8').trim();console.log(JSON.stringify({attempted:24,started:children.length,failed,events,group}));for(const child of children)child.kill('SIGTERM');process.exit(failed?2:0);`;

async function exercise(tasks: number) {
  const previous = process.env.PAPERCLIP_RUN_TASKS_MAX;
  process.env.PAPERCLIP_RUN_TASKS_MAX = String(tasks);
  try {
    return await runChildProcess(randomUUID(), process.execPath, ["-e", fixture], {
      cwd: process.cwd(), env: {}, timeoutSec: 10, graceSec: 1, onLog: async () => {},
    });
  } finally {
    if (previous === undefined) delete process.env.PAPERCLIP_RUN_TASKS_MAX;
    else process.env.PAPERCLIP_RUN_TASKS_MAX = previous;
  }
}

describe.skipIf(process.platform !== "linux")("bounded adapter process cap", () => {
  it("rejects a fixed process fixture at a low cap and passes the same fixture above that threshold", async () => {
    const low = await exercise(12);
    const high = await exercise(64);
    const limited = JSON.parse(low.stdout);
    const raised = JSON.parse(high.stdout);
    process.stdout.write(`cap-control low=${JSON.stringify({ exitCode: low.exitCode, ...limited })} high=${JSON.stringify({ exitCode: high.exitCode, ...raised })}\n`);
    expect(limited.group).toMatch(/paperclip-agent-.*\.scope$/);
    expect(limited.started).toBeLessThan(24);
    expect(limited.events).toMatch(/max [1-9]/);
    expect(low.exitCode).not.toBe(0);
    expect(raised.started).toBe(24);
    expect(raised.group).toMatch(/paperclip-agent-.*\.scope$/);
    expect(high.exitCode).toBe(0);
  }, 30_000);
});
