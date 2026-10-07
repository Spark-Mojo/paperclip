import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const defaults = { tasks: 2048, memory: 16 * 1024 ** 3 };

function limit(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("invalid_run_resource_limit");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("invalid_run_resource_limit");
  return parsed;
}

export function scopedRunCommand(_runId: string, command: string, args: string[]) {
  if (process.platform !== "linux") return { command, args, unit: null, env: {} };
  const tasks = limit(process.env.PAPERCLIP_RUN_TASKS_MAX, defaults.tasks);
  const memory = limit(process.env.PAPERCLIP_RUN_MEMORY_MAX_BYTES, defaults.memory);
  const unit = `paperclip-agent-${randomUUID().replace(/-/g, "")}.scope`;
  const script = 'set -eu; group=$(cut -d: -f3 /proc/self/cgroup); case "$group" in *"/$PAPERCLIP_RESOURCE_UNIT") ;; *) exit 125;; esac; root="/sys/fs/cgroup$group"; test "$(cat "$root/pids.max")" = "$PAPERCLIP_RESOURCE_TASKS"; test "$(cat "$root/memory.max")" = "$PAPERCLIP_RESOURCE_MEMORY"; exec "$@"';
  return {
    command: "systemd-run",
    args: ["--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, `--property=TasksMax=${tasks}`, `--property=MemoryMax=${memory}`, "--", "/bin/sh", "-c", script, "paperclip-run", command, ...args],
    unit,
    tasks,
    memory,
    env: { PAPERCLIP_RESOURCE_UNIT: unit, PAPERCLIP_RESOURCE_TASKS: String(tasks), PAPERCLIP_RESOURCE_MEMORY: String(memory) },
  };
}

export async function stopRunScope(unit: string | null): Promise<void> {
  if (!unit) return;
  await new Promise<void>((resolve, reject) => {
    const control = spawn("systemctl", ["--user", "stop", unit], { stdio: "ignore" });
    control.once("error", reject);
    control.once("close", (code) => code === 0 || code === 5 ? resolve() : reject(new Error(`run_scope_stop_failed:${code}`)));
  });
}
