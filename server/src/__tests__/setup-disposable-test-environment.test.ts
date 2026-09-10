import { expect, it } from "vitest";
import { loadConfig } from "../config.ts";

it("keeps server tests on the temporary embedded database configuration", () => {
  const config = loadConfig();

  expect(process.env.PAPERCLIP_CONFIG).toContain("paperclip-vitest-environment-");
  expect(process.env.DATABASE_URL).toBe("");
  expect(process.env.DATABASE_MIGRATION_URL).toBe("");
  expect(config).toMatchObject({
    databaseMode: "embedded-postgres",
    databaseUrl: "",
    databaseMigrationUrl: "",
    embeddedPostgresPort: 65432,
  });
});
