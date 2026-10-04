import { Command } from "commander";
import type { FleetMaxConcurrentRunsStatus } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

// SPA-10137: the fleet-wide run ceiling is the only instance-wide setting
// exposed through `get`/`set` today. Deliberately key/value shaped (rather
// than a one-off `fleet-cap` command) so a later live instance setting can be
// added as another supported key without a new command shape.
//
// The `instance` top-level command already exists in access.ts
// (registerAccessCommands) -- commander throws "cannot add command 'instance'
// as already have command 'instance'" if a second file tries to create it,
// which took down the whole CLI (and every e2e test that boots it) the first
// time this landed. So this module does NOT create `program.command("instance")`
// itself; the caller (access.ts) passes in the existing `instance` Command and
// this just adds the `get`/`set` subcommands onto it.
const FLEET_MAX_CONCURRENT_RUNS_KEY = "fleet-max-concurrent-runs";
const SUPPORTED_KEYS = [FLEET_MAX_CONCURRENT_RUNS_KEY] as const;

type InstanceCommandOptions = BaseClientOptions;

/** Mounts `instance get <key>` / `instance set <key> <value>` onto an existing `instance` Command. */
export function addFleetMaxConcurrentRunsCommands(instance: Command): void {
  addCommonClientOptions(
    instance
      .command("get")
      .description("Get an instance-wide setting")
      .argument("<key>", `Setting key (supported: ${SUPPORTED_KEYS.join(", ")})`)
      .action(async (key: string, opts: InstanceCommandOptions) => {
        try {
          assertSupportedKey(key);
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get<FleetMaxConcurrentRunsStatus>(
            "/api/instance/settings/fleet-max-concurrent-runs",
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    instance
      .command("set")
      .description("Set an instance-wide setting")
      .argument("<key>", `Setting key (supported: ${SUPPORTED_KEYS.join(", ")})`)
      .argument("<value>", 'New value. For fleet-max-concurrent-runs: an integer 1..50, or "none" for no ceiling')
      .action(async (key: string, value: string, opts: InstanceCommandOptions) => {
        try {
          assertSupportedKey(key);
          const parsedValue = parseFleetMaxConcurrentRunsValue(value);
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.patch<FleetMaxConcurrentRunsStatus>(
            "/api/instance/settings/fleet-max-concurrent-runs",
            { value: parsedValue },
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function assertSupportedKey(key: string): void {
  if (!(SUPPORTED_KEYS as readonly string[]).includes(key)) {
    throw new Error(
      `Unsupported instance setting key "${key}". Supported keys: ${SUPPORTED_KEYS.join(", ")}`,
    );
  }
}

/** Exported for tests. Parses the CLI's `<value>` argument for `set fleet-max-concurrent-runs`. */
export function parseFleetMaxConcurrentRunsValue(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase() === "none") return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new Error(
      `Invalid value "${raw}" for fleet-max-concurrent-runs. Use an integer 1..50, or "none" for no ceiling.`,
    );
  }
  return parsed;
}
