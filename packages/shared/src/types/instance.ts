import type { FeedbackDataSharingPreference } from "./feedback.js";

export const DAILY_RETENTION_PRESETS = [3, 7, 14] as const;
export const WEEKLY_RETENTION_PRESETS = [1, 2, 4] as const;
export const MONTHLY_RETENTION_PRESETS = [1, 3, 6] as const;
export interface BackupRetentionPolicy {
  dailyDays: (typeof DAILY_RETENTION_PRESETS)[number];
  weeklyWeeks: (typeof WEEKLY_RETENTION_PRESETS)[number];
  monthlyMonths: (typeof MONTHLY_RETENTION_PRESETS)[number];
}

export const DEFAULT_BACKUP_RETENTION: BackupRetentionPolicy = {
  dailyDays: 7,
  weeklyWeeks: 4,
  monthlyMonths: 1,
};

/**
 * Instance-wide execution policy.
 *
 * - `"any"` (default / absent): unrestricted — any environment driver (local,
 *   ssh, sandbox) may run agents. Preserves single-tenant / local-trusted
 *   behavior.
 * - `"kubernetes"`: force ALL agent execution onto the Kubernetes
 *   sandbox-provider environment and REFUSE local/in-process execution. Used by
 *   shared cloud (cloud_tenant) instances so untrusted tenant agents can never
 *   run in the server process or on an unsandboxed local/ssh adapter.
 */
export type InstanceExecutionMode = "kubernetes" | "any";

export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  keyboardShortcuts: boolean;
  feedbackDataSharingPreference: FeedbackDataSharingPreference;
  backupRetention: BackupRetentionPolicy;
  /**
   * Execution policy. Absent/`"any"` = unrestricted; `"kubernetes"` forces the
   * Kubernetes sandbox provider and denies local/ssh execution.
   */
  executionMode?: InstanceExecutionMode;
  /**
   * Live DB override for the fleet-wide ceiling on concurrently RUNNING agent
   * runs (server/src/services/heartbeat.ts `fleetMaxConcurrentRuns()`).
   * Integer 1..50 sets an explicit ceiling; `null` explicitly forces "no
   * ceiling", overriding the `PAPERCLIP_MAX_CONCURRENT_AGENT_RUNS` boot
   * default; absent leaves the env var (if any) in control. See
   * `FleetMaxConcurrentRunsStatus` for the resolved effective value and its
   * source — this field is the stored override only, not the effective one.
   */
  fleetMaxConcurrentRuns?: number | null;
}

/** Where the effective fleet-wide run ceiling came from. */
export type FleetMaxConcurrentRunsSource = "db" | "env" | "none";

/**
 * The resolved, effective fleet-wide run ceiling plus where it came from.
 * Precedence: an explicit DB value (`InstanceGeneralSettings.fleetMaxConcurrentRuns`)
 * wins over `PAPERCLIP_MAX_CONCURRENT_AGENT_RUNS`, which wins over "no ceiling".
 */
export interface FleetMaxConcurrentRunsStatus {
  value: number | null;
  source: FleetMaxConcurrentRunsSource;
}

export interface InstanceExperimentalSettings {
  enableEnvironments: boolean;
  /**
   * Exposes the experimental Paperclip Runner adapter for new selections.
   * Existing native runs ignore later flag changes so they remain recoverable.
   */
  enableNativeRunner: boolean;
  /**
   * Hide the local environment and run all agents in the platform-managed
   * sandbox environment. Run selection refuses local while this is on.
   */
  enableManagedSandboxOnly: boolean;
  enableIsolatedWorkspaces: boolean;
  /**
   * Move the execution workspace default for a project that carries no policy
   * of its own from the shared project checkout to an isolated per-task
   * worktree. Inert unless `enableIsolatedWorkspaces` is also on, and never
   * overrides a project that stores its own policy.
   */
  enableIsolatedWorkspacesByDefault: boolean;
  enableStreamlinedLeftNavigation: boolean;
  /**
   * Use the streamlined shell, navigation, and contextual-sidebar experience.
   * Missing legacy values default on; the retired left-navigation preference
   * remains separate so an old opt-out cannot disable the broader UI.
   */
  enableStreamlinedUi: boolean;
  /** @deprecated Compatibility key only. Apps is always enabled. */
  enableApps: boolean;
  /** Exposes chat connector setup and Board surfaces; existing delivery continues when hidden. */
  enableChatConnectors: boolean;
  enablePipelines: boolean;
  enableCases: boolean;
  enableAgentChat: boolean;
  enableConferenceRoomChat: boolean;
  enableClassicTaskInterface: boolean;
  enableIssuePlanDecompositions: boolean;
  enableExperimentalFileViewer: boolean;
  enableExternalObjects: boolean;
  enableSmokeLab: boolean;
  enableBuiltInAgents: boolean;
  enableBetaSkills: boolean;
  enableSummaries: boolean;
  enableStatusCards: boolean;
  enableDecisions: boolean;
  enableGoalsSidebarLink: boolean;
  enableServerInfoDebugView: boolean;
  /** Shows internal Paperclip maintainer tools and observability links. */
  enablePaperclipDeveloperMode: boolean;
  /**
   * Instructs agents to write user-interaction content (confirmations,
   * questions, suggested tasks, checkbox prompts) in ASD-STE100 Simplified
   * Technical English with brief decision context. Prompt-side only; no
   * behavior change outside interaction wording.
   */
  enableSimplifiedEnglishInteractions: boolean;
  /**
   * When the user's first onboarding request is a single task, the chief of
   * staff proposes with a short plan document and a checkbox card instead of a
   * one-card confirmation. Read once, when the onboarding first task is created;
   * flipping it later does not change an existing first task.
   */
  enableFirstTaskPlanProposal: boolean;
  autoRestartDevServerWhenIdle: boolean;
  enableWorkspaceBranchReconcileForward: boolean;
  enableWorkspaceDirtyQuarantineRepair: boolean;
  /**
   * On cloud-managed instances, grant the stack owner instance-admin access
   * to their own dedicated instance. Elevation is computed per request at the
   * trusted-header auth boundary (owner stack role + this flag); no
   * `instance_user_roles` row is ever written. Inert on self-hosted
   * instances, which have no trusted cloud tenant path.
   */
  enableOwnerInstanceAdmin: boolean;
  /**
   * Kill switch for the sandbox duplex command-stream bridge. Default off. The
   * host reads this per run before it selects the callback bridge transport.
   * Off forces the file bridge for every run with no manifest change and no
   * redeploy.
   */
  enableSandboxDuplexBridge: boolean;
  /**
   * @deprecated Compatibility-only. Provider WebSocket ingress now follows
   * enableNativeRunner and this value has no runtime effect.
   */
  enableRunnerPreviewIngress: boolean;
  /**
   * Worktree preview instances (`PAPERCLIP_IN_WORKTREE=true`) suppress the
   * heartbeat run engine by default so previews never self-execute tasks. When
   * this is enabled the worktree-instance scheduling suppression is lifted so
   * runs actually execute inside the preview. Ignored outside a worktree.
   */
  enableWorktreeRunExecution: boolean;
  /**
   * Server-managed cutoff recorded when worktree run execution is enabled in
   * this instance. Client PATCH payloads must not control this value.
   */
  worktreeRunExecutionActivatedAt: string | null;
  /**
   * Server-managed instance id captured with the cutoff so copied settings rows
   * from another instance fail closed.
   */
  worktreeRunExecutionActivationInstanceId: string | null;
  /**
   * SPA-9275: ephemeral worktree mode. When enabled, the engine provisions one
   * git worktree PER RUN (under `<worktreeParentDir>/runs/<runId>/`) instead of
   * one per card; the run pushes its branch and force-removes the directory at
   * terminal status (success/failure/cancel/process-lost). A startup reaper
   * sweeps any `/runs/<runId>/` directory whose owning run is no longer live,
   * rescuing unpushed branches first. Default OFF — the per-card persistent
   * worktree behavior is unchanged until an operator opts in.
   */
  enableEphemeralWorktreePerRun: boolean;
}

/**
 * Boolean feature-flag keys of the experimental settings — the only keys a
 * cloud managed-config overlay may target. Server-managed bookkeeping fields
 * (activation cutoffs, lookback hours) are excluded by construction.
 */
export type ManagedExperimentalFeatureKey = {
  [K in keyof InstanceExperimentalSettings]-?: InstanceExperimentalSettings[K] extends boolean
    ? K
    : never;
}[keyof InstanceExperimentalSettings];

export const PAPERCLIP_CLOUD_MANAGED_BY = "paperclip-cloud" as const;

/** Per-key metadata attached to settings responses for cloud-overlaid keys. */
export interface ManagedSettingMetadata {
  managed: true;
  managedBy: typeof PAPERCLIP_CLOUD_MANAGED_BY;
}

/**
 * Experimental settings as returned by the settings API. On cloud-managed
 * instances (`PAPERCLIP_MANAGED_CONFIG` present) `managedKeys` lists every key
 * whose value is overlaid by the harness; self-hosted responses omit it.
 */
export interface InstanceExperimentalSettingsWithManaged extends InstanceExperimentalSettings {
  managedKeys?: Partial<Record<ManagedExperimentalFeatureKey, ManagedSettingMetadata>>;
}

export interface InstanceSettings {
  id: string;
  defaultEnvironmentId: string | null;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettingsWithManaged;
  createdAt: Date;
  updatedAt: Date;
}
