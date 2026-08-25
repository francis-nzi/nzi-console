export type DatabaseBoundaryConfig = { appEnv?: string; boundaryToken?: string; isolatedDatabaseUrl?: string };
export function validateDatabaseBoundary(config: DatabaseBoundaryConfig): URL {
  if (config.appEnv === "production") throw new Error("Isolated database access is forbidden when APP_ENV is production.");
  if (config.boundaryToken !== "isolated-non-production") throw new Error("NZI_DATABASE_BOUNDARY must confirm isolated-non-production.");
  if (!config.isolatedDatabaseUrl?.trim()) throw new Error("NZI_ISOLATED_DATABASE_URL is required.");
  const url = new URL(config.isolatedDatabaseUrl);
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new Error("Only PostgreSQL targets are supported.");
  if (!url.searchParams.has("application_name")) url.searchParams.set("application_name", "nzi-console-isolated");
  return url;
}

export const requiredMigrationInvariants = [
  "ENABLE ROW LEVEL SECURITY", "FORCE ROW LEVEL SECURITY", "NOBYPASSRLS", "app.organisation_id",
  "PRIMARY KEY (organisation_id", "command_idempotency", "audit_events", "transactional_outbox",
] as const;
