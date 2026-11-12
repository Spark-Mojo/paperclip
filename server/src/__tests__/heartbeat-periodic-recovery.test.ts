import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  completionSweepMock,
  createAppMock,
  createBetterAuthInstanceMock,
  createDbMock,
  detectPortMock,
  deriveAuthTrustedOriginsMock,
  environmentCustomImagesServiceMock,
  environmentCustomImagesServiceFactoryMock,
  executionWorkspaceServiceFactoryMock,
  executionWorkspaceServiceMock,
  externalObjectsServiceMock,
  externalObjectsServiceFactoryMock,
  feedbackServiceFactoryMock,
  fakeServer,
  heartbeatServiceFactoryMock,
  heartbeatServiceMock,
  issueThreadInteractionServiceFactoryMock,
  issueThreadInteractionServiceMock,
  loadConfigMock,
  resolveHeartbeatSchedulingSuppressionMock,
  routineServiceFactoryMock,
  routineServiceMock,
} = vi.hoisted(() => {
  const completionSweepMock = vi.fn(async () => undefined);
  const createAppMock = vi.fn(async () => Object.assign((_: unknown, __: unknown) => {}, {
    locals: {
      toolGateway: {
        sweepActionReviews: vi.fn(async () => ({ scanned: 0 })),
        cleanupExpiredSessions: vi.fn(async () => ({ deletedCount: 0 })),
      },
      toolActionDeliveries: { sweepPending: vi.fn(async () => ({ scanned: 0, delivered: 0 })) },
    },
  }) as never);
  const createBetterAuthInstanceMock = vi.fn(() => ({}));
  const createDbMock = vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(async () => []) })),
    })),
  }) as never);
  const detectPortMock = vi.fn(async ({ port }: { port: number; hostname: string }) => port);
  const deriveAuthTrustedOriginsMock = vi.fn(() => []);
  const resolveHeartbeatSchedulingSuppressionMock = vi.fn(() => ({
    suppressed: false,
    reason: null,
  }));
  const heartbeatServiceMock = {
    resolveSchedulingSuppression: resolveHeartbeatSchedulingSuppressionMock,
    recoverNativeRunsAfterRestart: vi.fn(async () => ({
      restartKind: "hard",
      dispositions: [],
      claims: [],
      awaitingEvidenceRunIds: [],
      blockedRunIds: [],
    })),
    reconcileHotRestartAdoption: vi.fn(async () => ({ mode: "none" })),
    reapOrphanedRuns: vi.fn(async () => ({ reaped: 0, runIds: [] })),
    promoteDueScheduledRetries: vi.fn(async () => ({ promoted: 0, runIds: [] })),
    resumeQueuedRuns: vi.fn(async () => undefined),
    recoverPendingSessionGoalActions: vi.fn(async () => ({ scanned: 0, enqueued: 0, alreadyQueued: 0, invalid: 0 })),
    recoverActiveSessionGoals: vi.fn(async () => ({ scanned: 0, enqueued: 0 })),
    reconcileStrandedAssignedIssues: vi.fn(async () => ({
      assignmentDispatched: 0,
      dispatchRequeued: 0,
      continuationRequeued: 0,
      successfulRunHandoffEscalated: 0,
      escalated: 0,
      skipped: 0,
      issueIds: [],
    })),
    reconcileResolvedDependencyWakes: vi.fn(async () => ({ healed: 0 })),
    reconcileTaskWatchdogs: vi.fn(async () => ({ triggered: 0 })),
    scanSilentActiveRuns: vi.fn(async () => ({ created: 0, escalated: 0 })),
    sweepStaleIssueLocks: vi.fn(async () => ({ cleared: 0 })),
    sweepPendingCleanupLeases: vi.fn(async () => ({ swept: 0, destroyed: 0, capped: 0 })),
    sweepExpiredRuntimeStatuses: vi.fn(() => 0),
    tickTimers: vi.fn(async () => ({ checked: 0, enqueued: 0, skipped: 0 })),
  };
  const heartbeatServiceFactoryMock = vi.fn(() => heartbeatServiceMock);
  const issueThreadInteractionServiceMock = {
    sweepSupersededPendingRequestConfirmations: vi.fn(async () => ({ expired: 0 })),
    sweepMergedPullRequestConfirmations: vi.fn(async () => ({
      checked: 0,
      candidates: 0,
      accepted: 0,
      woken: 0,
    })),
  };
  const issueThreadInteractionServiceFactoryMock = vi.fn(() => issueThreadInteractionServiceMock);
  const environmentCustomImagesServiceMock = {
    cleanupExpiredSetupSessions: vi.fn(async () => ({ scanned: 0, timedOut: 0, failed: 0 })),
  };
  const environmentCustomImagesServiceFactoryMock = vi.fn(() => environmentCustomImagesServiceMock);
  const executionWorkspaceServiceMock = {
    sweepTerminalWorkspaces: vi.fn(async () => ({
      checked: 0,
      eligible: 0,
      archived: 0,
      cleanupFailed: 0,
      skippedActiveRun: 0,
      skippedNonTerminalTree: 0,
      skippedUndelivered: 0,
      skippedRace: 0,
    })),
  };
  const executionWorkspaceServiceFactoryMock = vi.fn(() => executionWorkspaceServiceMock);
  const externalObjectsServiceMock = {
    refreshDueObjectsForActiveCompanies: vi.fn(async () => ({ companies: 0, checked: 0, refreshed: 0 })),
  };
  const externalObjectsServiceFactoryMock = vi.fn(() => externalObjectsServiceMock);
  const routineServiceMock = {
    tickScheduledTriggers: vi.fn(async () => ({ triggered: 0 })),
  };
  const routineServiceFactoryMock = vi.fn(() => routineServiceMock);
  const feedbackExportServiceMock = {
    flushPendingFeedbackTraces: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0 })),
  };
  const feedbackServiceFactoryMock = vi.fn(() => feedbackExportServiceMock);
  const fakeServer = {
    on: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    listen: vi.fn((_port: number, _host: string, callback?: () => void) => {
      callback?.();
      return fakeServer;
    }),
    close: vi.fn((callback?: (error?: Error) => void) => callback?.()),
  };
  const loadConfigMock = vi.fn();

  return {
    completionSweepMock,
    createAppMock,
    createBetterAuthInstanceMock,
    createDbMock,
    detectPortMock,
    deriveAuthTrustedOriginsMock,
    environmentCustomImagesServiceMock,
    environmentCustomImagesServiceFactoryMock,
    executionWorkspaceServiceFactoryMock,
    executionWorkspaceServiceMock,
    externalObjectsServiceMock,
    externalObjectsServiceFactoryMock,
    feedbackServiceFactoryMock,
    feedbackExportServiceMock,
    fakeServer,
    heartbeatServiceFactoryMock,
    heartbeatServiceMock,
    issueThreadInteractionServiceFactoryMock,
    issueThreadInteractionServiceMock,
    loadConfigMock,
    resolveHeartbeatSchedulingSuppressionMock,
    routineServiceFactoryMock,
    routineServiceMock,
  };
});

function buildTestConfig(overrides: Record<string, unknown> = {}) {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    bind: "loopback",
    customBindHost: undefined,
    host: "127.0.0.1",
    port: 3210,
    allowedHostnames: [],
    authBaseUrlMode: "auto",
    authPublicBaseUrl: undefined,
    authDisableSignUp: false,
    databaseMode: "postgres",
    databaseUrl: "postgres://paperclip:paperclip@127.0.0.1:5432/paperclip",
    embeddedPostgresDataDir: "/tmp/paperclip-test-db",
    embeddedPostgresPort: 54329,
    databaseBackupEnabled: false,
    databaseBackupIntervalMinutes: 60,
    databaseBackupRetentionDays: 30,
    databaseBackupDir: "/tmp/paperclip-test-backups",
    serveUi: false,
    uiDevMiddleware: false,
    secretsProvider: "local_encrypted",
    secretsStrictMode: false,
    secretsMasterKeyFilePath: "/tmp/paperclip-master.key",
    storageProvider: "local_disk",
    storageLocalDiskBaseDir: "/tmp/paperclip-storage",
    storageS3Bucket: "paperclip-test",
    storageS3Region: "us-east-1",
    storageS3Endpoint: undefined,
    storageS3Prefix: "",
    storageS3ForcePathStyle: false,
    feedbackExportBackendUrl: "https://telemetry.example.com",
    feedbackExportBackendToken: "telemetry-token",
    heartbeatSchedulerEnabled: false,
    heartbeatSchedulerIntervalMs: 30000,
    companyDeletionEnabled: false,
    ...overrides,
  };
}

vi.mock("node:http", () => ({
  createServer: vi.fn(() => fakeServer),
}));

vi.mock("detect-port", () => ({
  default: detectPortMock,
}));

vi.mock("@paperclipai/db", () => ({
  createDb: createDbMock,
  ensurePostgresDatabase: vi.fn(),
  getPostgresDataDirectory: vi.fn(),
  inspectMigrations: vi.fn(async () => ({ status: "upToDate" })),
  applyPendingMigrations: vi.fn(),
  reconcilePendingMigrationHistory: vi.fn(async () => ({ repairedMigrations: [] })),
  formatDatabaseBackupResult: vi.fn(() => "ok"),
  runDatabaseBackup: vi.fn(),
  authUsers: {},
  companies: {},
  companyMemberships: {},
  instanceUserRoles: {},
}));

vi.mock("../app.js", () => ({
  createApp: createAppMock,
}));

vi.mock("../services/native-runtime/native-session-executor.js", () => ({
  verifyStoppedNativeSessionForReplacement: vi.fn(async () => null),
}));

vi.mock("../services/native-runtime/native-safe-replacement.js", () => ({
  reconcileSafeNativeReplacements: vi.fn(async () => ({ scanned: 0, scheduled: 0 })),
}));

vi.mock("../config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child() {
      return this;
    }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../realtime/live-events-ws.js", () => ({
  setupLiveEventsWebSocketServer: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  backfillLegacyToolOAuthTokens: vi.fn(async () => ({
    scannedConnections: 0,
    migratedConnections: 0,
    sanitizedConnections: 0,
    createdSecrets: 0,
    rotatedSecrets: 0,
    accessTokensBackfilled: 0,
    refreshTokensBackfilled: 0,
  })),
  backfillPrincipalAccessCompatibility: vi.fn(async () => ({
    agentMembershipsInserted: 0,
    humanGrantsInserted: 0,
  })),
  attentionService: vi.fn(() => ({
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
  })),
  decisionService: vi.fn(() => ({
    sweepExpired: vi.fn(async () => ({ expired: 0 })),
  })),
  decisionRetentionService: vi.fn(() => ({
    autoArchive: vi.fn(async () => 0),
    deliverNotifications: vi.fn(async () => ({ notifiedAgents: 0, delivered: 0 })),
  })),
  feedbackService: feedbackServiceFactoryMock,
  bootstrapExecutionPolicyFromEnv: vi.fn(async () => null),
  applyManagedEnvironments: vi.fn(async () => null),
  environmentCustomImageService: environmentCustomImagesServiceFactoryMock,
  executionWorkspaceService: executionWorkspaceServiceFactoryMock,
  externalObjectService: externalObjectsServiceFactoryMock,
  heartbeatService: heartbeatServiceFactoryMock,
  githubConnectionEventService: vi.fn(() => ({
    pollOnce: vi.fn(async () => ({
      leased: 0,
      processed: 0,
      duplicate: 0,
      ignored: 0,
      failed: 0,
    })),
  })),
  issueThreadInteractionService: issueThreadInteractionServiceFactoryMock,
  issueService: vi.fn(() => ({ update: vi.fn(async () => null) })),
  instanceSettingsService: vi.fn(() => ({
    getExperimental: vi.fn(async () => ({
      enableExternalObjects: true,
      enableStatusCards: false,
    })),
    getGeneral: vi.fn(async () => ({
      backupRetention: {
        dailyDays: 7,
        weeklyWeeks: 4,
        monthlyMonths: 1,
      },
    })),
  })),
  reconcileCodexLocalManagedHomesOnStartup: vi.fn(async () => ({
    scanned: 0,
    seeded: 0,
    alreadySeeded: 0,
    externalOverride: 0,
    noManagedHome: 0,
    sourceAuthMissing: 0,
    failed: 0,
    seededAgentIds: [],
  })),
  reconcileBuiltInAgentsOnStartup: vi.fn(async () => ({
    scanned: 0,
    reconciled: 0,
    unknown: 0,
    duplicates: 0,
  })),
  reconcilePersistedRuntimeServicesOnStartup: vi.fn(async () => ({ reconciled: 0 })),
  resolveHeartbeatSchedulingSuppression: resolveHeartbeatSchedulingSuppressionMock,
  routineService: routineServiceFactoryMock,
  statusCardService: vi.fn(() => ({})),
  toolAccessService: vi.fn(() => ({
    sweepConnectionHealth: vi.fn(async () => ({
      checked: 0,
      healthy: 0,
      needsAttention: 0,
      failed: 0,
    })),
    sweepGitHubConnectionContinuity: vi.fn(async () => ({
      checked: 0,
      due: 0,
      refreshed: 0,
      failed: 0,
    })),
  })),
}));

vi.mock("../services/chat-completion-delivery.js", () => ({ chatCompletionDeliveryService: () => ({ sweepPending: completionSweepMock }) }));

vi.mock("../services/connection-intent-delivery.js", () => ({
  connectionIntentDeliveryService: vi.fn(() => ({
    sweepPending: vi.fn(async () => ({ scanned: 0, failed: 0 })),
  })),
}));

vi.mock("../services/question-response-delivery.js", () => ({
  questionResponseDeliveryService: vi.fn(() => ({
    sweepPending: vi.fn(async () => ({
      scanned: 0,
      steered: 0,
      coalesced: 0,
      wakeFallback: 0,
      failed: 0,
    })),
  })),
}));

vi.mock("../services/native-runtime/native-question-bridge.js", () => ({
  deliverNativeQuestionResponse: vi.fn(async () => "not_native"),
  nativeQuestionCancellationIdentity: vi.fn(() => null),
  nativeQuestionRunToCancel: vi.fn(async () => null),
  validateNativeQuestionResponseInput: vi.fn(),
}));

vi.mock("../services/secret-proposals.js", () => ({
  createSecretProposalsService: vi.fn(() => ({
    sweepExpired: vi.fn(async () => 0),
  })),
}));

vi.mock("../storage/index.js", () => ({
  createStorageServiceFromConfig: vi.fn(() => ({ id: "storage-service" })),
}));

vi.mock("../services/feedback-share-client.js", () => ({
  createFeedbackTraceShareClientFromConfig: vi.fn(() => ({ id: "feedback-share-client" })),
}));

vi.mock("../services/plugin-worker-manager.js", () => ({
  createPluginWorkerManager: vi.fn(() => ({ id: "plugin-worker-manager" })),
}));

vi.mock("../startup-banner.js", () => ({
  printStartupBanner: vi.fn(),
}));

vi.mock("../board-claim.js", () => ({
  getBoardClaimWarningUrl: vi.fn(() => null),
  initializeBoardClaimChallenge: vi.fn(async () => undefined),
}));

vi.mock("../auth/better-auth.js", () => ({
  createBetterAuthHandler: vi.fn(() => undefined),
  createBetterAuthInstance: createBetterAuthInstanceMock,
  deriveAuthTrustedOrigins: deriveAuthTrustedOriginsMock,
  resolveBetterAuthSession: vi.fn(async () => null),
  resolveBetterAuthSessionFromHeaders: vi.fn(async () => null),
}));

import { startServer } from "../index.ts";
import { logger } from "../middleware/logger.js";

const HEARTBEAT_INTERVAL_MS = 30000;
const WHOLE_CHAIN_ABORT_MESSAGE = "periodic heartbeat recovery failed";

type ErrorCall = { context: unknown; message: unknown };

function errorCalls(): ErrorCall[] {
  const errorMock = logger.error as unknown as { mock: { calls: unknown[][] } };
  return errorMock.mock.calls.map(([context, message]) => ({ context, message }));
}

function callsCarrying(error: unknown): ErrorCall[] {
  return errorCalls().filter(({ context }) => (context as { err?: unknown } | null)?.err === error);
}

async function flushAsync(rounds = 30): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// Boots the server with the heartbeat scheduler enabled and returns the
// captured periodic scheduler tick. Startup recovery runs to completion
// inside startServer, so callers clear mocks afterwards to isolate one tick.
async function startWithPeriodicTick(): Promise<{ tick: () => void; restore: () => void }> {
  loadConfigMock.mockReturnValue(buildTestConfig({
    heartbeatSchedulerEnabled: true,
    heartbeatSchedulerIntervalMs: HEARTBEAT_INTERVAL_MS,
  }));
  const captured: Array<{ callback: () => void; intervalMs: unknown }> = [];
  const setIntervalSpy = vi
    .spyOn(globalThis, "setInterval")
    .mockImplementation(((callback: () => void, intervalMs?: number) => {
      captured.push({ callback, intervalMs });
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);

  await startServer();

  const tick = captured.find(({ intervalMs }) => intervalMs === HEARTBEAT_INTERVAL_MS)?.callback;
  expect(tick).not.toBeUndefined();
  return {
    tick: tick as () => void,
    restore: () => setIntervalSpy.mockRestore(),
  };
}

describe("periodic heartbeat recovery isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "fedcba9876543210fedcba9876543210";
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "0123456789abcdef0123456789abcdef";
    loadConfigMock.mockReturnValue(buildTestConfig());
    resolveHeartbeatSchedulingSuppressionMock.mockReturnValue({
      suppressed: false,
      reason: null,
    });
    createBetterAuthInstanceMock.mockReturnValue({});
    deriveAuthTrustedOriginsMock.mockReturnValue([]);
    process.env.BETTER_AUTH_SECRET = "test-secret";
  });

  it("drives every downstream reconciler exactly once when stranded-issue recovery fails", async () => {
    const { tick, restore } = await startWithPeriodicTick();
    try {
      // Isolate the periodic tick from the startup recovery pass.
      vi.clearAllMocks();
      heartbeatServiceMock.reconcileStrandedAssignedIssues.mockRejectedValueOnce(
        new Error("stranded-issue boom"),
      );

      tick();
      await vi.waitFor(
        () => {
          expect(heartbeatServiceMock.sweepStaleIssueLocks).toHaveBeenCalledTimes(1);
        },
        { timeout: 5000 },
      );
      await flushAsync();

      expect(heartbeatServiceMock.reapOrphanedRuns).toHaveBeenCalledTimes(1);
      expect(heartbeatServiceMock.promoteDueScheduledRetries).toHaveBeenCalledTimes(1);
      expect(heartbeatServiceMock.reconcileResolvedDependencyWakes).toHaveBeenCalledTimes(1);
      expect(heartbeatServiceMock.reconcileTaskWatchdogs).toHaveBeenCalledTimes(1);
      expect(heartbeatServiceMock.scanSilentActiveRuns).toHaveBeenCalledTimes(1);
      expect(heartbeatServiceMock.sweepStaleIssueLocks).toHaveBeenCalledTimes(1);
      expect(errorCalls().map(({ message }) => message)).not.toContain(WHOLE_CHAIN_ABORT_MESSAGE);
    } finally {
      restore();
    }
  });

  it("logs the stranded-issue failure at step level without the whole-chain abort log", async () => {
    const { tick, restore } = await startWithPeriodicTick();
    try {
      vi.clearAllMocks();
      const boom = new Error("stranded-issue boom");
      heartbeatServiceMock.reconcileStrandedAssignedIssues.mockRejectedValueOnce(boom);

      tick();
      // The injected failure must surface on a logger.error call either way
      // (whole-chain abort today, isolated step log once fixed).
      await vi.waitFor(
        () => {
          expect(callsCarrying(boom).length).toBeGreaterThan(0);
        },
        { timeout: 5000 },
      );
      await flushAsync();

      const boomCalls = callsCarrying(boom);
      expect(boomCalls.length).toBeGreaterThan(0);
      expect(boomCalls.some(({ message }) => message !== WHOLE_CHAIN_ABORT_MESSAGE)).toBe(true);
      expect(errorCalls().map(({ message }) => message)).not.toContain(WHOLE_CHAIN_ABORT_MESSAGE);
    } finally {
      restore();
    }
  });

  it("still runs every recovery step when stranded-issue recovery succeeds", async () => {
    const { tick, restore } = await startWithPeriodicTick();
    try {
      vi.clearAllMocks();

      tick();
      await vi.waitFor(
        () => {
          expect(heartbeatServiceMock.sweepStaleIssueLocks).toHaveBeenCalledTimes(1);
        },
        { timeout: 5000 },
      );
      await flushAsync();

      expect(heartbeatServiceMock.reapOrphanedRuns).toHaveBeenCalledTimes(1);
      expect(heartbeatServiceMock.promoteDueScheduledRetries).toHaveBeenCalledTimes(1);
      expect(heartbeatServiceMock.reconcileStrandedAssignedIssues).toHaveBeenCalledTimes(1);
      expect(heartbeatServiceMock.reconcileResolvedDependencyWakes).toHaveBeenCalledTimes(1);
      expect(heartbeatServiceMock.reconcileTaskWatchdogs).toHaveBeenCalledTimes(1);
      expect(heartbeatServiceMock.scanSilentActiveRuns).toHaveBeenCalledTimes(1);
      expect(heartbeatServiceMock.sweepStaleIssueLocks).toHaveBeenCalledTimes(1);
      expect(errorCalls().map(({ message }) => message)).not.toContain(WHOLE_CHAIN_ABORT_MESSAGE);
    } finally {
      restore();
    }
  });
});
