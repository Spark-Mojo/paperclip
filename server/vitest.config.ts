import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@paperclipai\/paperclip-runner$/,
        replacement: fileURLToPath(
          new URL("../packages/paperclip-runner/src/index.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    // Each server suite boots + tears down its own embedded Postgres in
    // beforeAll/afterAll. Under the loaded serial shard (maxWorkers=1) the
    // graceful shutdown can occasionally cross vitest's default 10s hookTimeout,
    // producing flaky "Hook timed out in 10000ms" afterAll failures on CI. Give
    // the boot/teardown hooks generous headroom; 30s is far above the observed
    // worst-case teardown yet still catches a genuinely hung hook. teardownTimeout
    // mirrors it for the same reason.
    hookTimeout: 30000,
    teardownTimeout: 30000,
    // The route/authz suites import very large modules (for example
    // src/routes/issues.ts and its dependency graph). The first test in each
    // file pays the one-time transform cost inside its own timeout budget. On
    // the loaded serial shard (maxWorkers=1) that cost can cross vitest's
    // default 5s testTimeout and fail the first test, which also lets its
    // fire-and-forget wake leak into the next test.
    // Calibration as of 2026-11-10 (SPA-18748 O1/O2; SPA-18769 R3 direct
    // measurement): the observed one-time cold import of large route-module
    // graphs on this box is ~26-37s. 15000ms is BELOW that one-time cost and
    // relies on per-suite warm-up hooks (SPA-17642 pattern) to absorb it.
    // Standing rule, self-contained: each new warm-up leaf re-measures the
    // cold import and flags when a fresh measurement exceeds ~2x the
    // ~26-37s band stated here. 15000ms still catches a genuinely hung test
    // well inside the 20 minute job limit.
    testTimeout: 15000,
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    // Server suites share process state and one embedded Postgres instance,
    // so tests inside a file must run one at a time. Do not set
    // sequence.concurrent to true.
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    setupFiles: ["./src/__tests__/setup-supertest.ts"],
  },
});
