const PROTECTED_DATABASE_NAMES = new Set([
  "paperclip_spa_cutover_20260906",
]);

export type DisposableTestDatabaseIdentity = {
  host: string;
  port: string;
  database: string;
};

function databaseNameFromUrl(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\/+/, ""));
}

export function assertDisposableTestDatabaseTarget(
  connectionString: string,
): DisposableTestDatabaseIdentity {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("Test database target must be a valid PostgreSQL connection string");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("Test database target must use the postgres protocol");
  }

  if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") {
    throw new Error("Test database target must use a loopback host");
  }

  const database = databaseNameFromUrl(url);
  if (!database) {
    throw new Error("Test database target must name a database");
  }
  if (PROTECTED_DATABASE_NAMES.has(database)) {
    throw new Error(`Test database target refuses protected database ${database}`);
  }

  return {
    host: url.hostname,
    port: url.port || "5432",
    database,
  };
}
