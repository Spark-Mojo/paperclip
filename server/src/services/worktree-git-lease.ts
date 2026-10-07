import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";

const context = new AsyncLocalStorage<{ key: string; exclusive: boolean; active: boolean }>();
const pending = new Map<string, { barrier: Promise<void>; readers: Set<Promise<void>>; waiting: number }>();
const poisoned = new Set<string>();

export async function withWorktreeGitLease<T>(
  workspacePath: string,
  operation: () => Promise<T>,
  exclusive = false,
): Promise<T> {
  const key = await fs.realpath(workspacePath);
  if (poisoned.has(key)) throw new Error(`Worktree Git lease timed out at ${key}`);
  const owner = context.getStore();
  if (owner?.key === key && owner.active) {
    if (exclusive && !owner.exclusive) throw new Error(`Cannot upgrade worktree Git lease at ${key}`);
    return operation();
  }

  const state = pending.get(key) ?? { barrier: Promise.resolve(), readers: new Set<Promise<void>>(), waiting: 0 };
  pending.set(key, state);
  const preceding = exclusive ? Promise.all([state.barrier, ...state.readers]) : state.barrier;
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  state.waiting += 1;
  if (exclusive) {
    state.barrier = current;
    state.readers.clear();
  } else {
    state.readers.add(current);
  }
  let token: { key: string; exclusive: boolean; active: boolean } | undefined;
  try {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        preceding,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out waiting for worktree Git lease at ${key}`)), 30_000);
        }),
      ]);
    } catch (error) {
      poisoned.add(key);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (poisoned.has(key)) throw new Error(`Worktree Git lease timed out at ${key}`);
    token = { key, exclusive, active: true };
    return await context.run(token, operation);
  } finally {
    if (token) token.active = false;
    state.readers.delete(current);
    state.waiting -= 1;
    if (state.waiting === 0) {
      pending.delete(key);
      poisoned.delete(key);
    }
    release();
  }
}
