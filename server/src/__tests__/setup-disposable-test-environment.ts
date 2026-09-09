import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertDisposableTestDatabaseTarget } from "@paperclipai/db/test-database-safety";

function rejectInheritedDatabaseTarget(variable: "DATABASE_URL" | "DATABASE_MIGRATION_URL") {
  const value = process.env[variable]?.trim();
  if (!value) return;

  // Validate first so a protected target receives a precise failure, rather than
  // silently disappearing beneath the test-only configuration.
  assertDisposableTestDatabaseTarget(value);
  throw new Error(`${variable} must not be inherited by server tests`);
}

rejectInheritedDatabaseTarget("DATABASE_URL");
rejectInheritedDatabaseTarget("DATABASE_MIGRATION_URL");

// config.ts also loads a cwd .env with dotenv's non-overriding mode. Define
// blank values before application modules load so that file cannot replace this
// test-only embedded target with an inherited database endpoint.
process.env.DATABASE_URL = "";
process.env.DATABASE_MIGRATION_URL = "";

if (process.env.PAPERCLIP_CONFIG?.trim()) {
  throw new Error("PAPERCLIP_CONFIG must not be inherited by server tests");
}

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-vitest-environment-"));
const configPath = path.join(testRoot, "config.json");
const databaseDir = path.join(testRoot, "embedded-postgres");
const port = 65432;

fs.writeFileSync(
  configPath,
  `${JSON.stringify({
    $meta: {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      source: "onboard",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: databaseDir,
      embeddedPostgresPort: port,
      backup: {
        enabled: false,
        intervalMinutes: 60,
        retentionDays: 1,
        dir: path.join(testRoot, "backups"),
      },
    },
    logging: { mode: "file", logDir: path.join(testRoot, "logs") },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: false,
    },
    telemetry: { enabled: false },
    updates: { checkEnabled: false },
    auth: { baseUrlMode: "auto", disableSignUp: false },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: path.join(testRoot, "storage") },
      s3: { bucket: "paperclip", region: "us-east-1", prefix: "", forcePathStyle: false },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: { keyFilePath: path.join(testRoot, "secrets", "master.key") },
    },
  }, null, 2)}\n`,
  { mode: 0o600 },
);

process.env.PAPERCLIP_CONFIG = configPath;
process.env.PAPERCLIP_HOME = testRoot;
process.env.PAPERCLIP_INSTANCE_ID = "vitest";
process.env.PAPERCLIP_EMBEDDED_POSTGRES_PORT = String(port);

const target = assertDisposableTestDatabaseTarget(
  `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`,
);
console.info(
  `[paperclip-test-target] mode=embedded-postgres host=${target.host} port=${target.port} database=${target.database} config=temporary`,
);
