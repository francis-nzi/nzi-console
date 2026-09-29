/**
 * What this running service is, in one place — so `/api/health` and the admin top bar's environment badge cannot
 * say different things. Derived from the environment the process was started with, never from a constant.
 */
export type ServiceEnvironment = {
  env: string;
  dataMode: "isolated-api" | "fixture";
  isolation: "no-database" | "non-production-only";
  writes: "enabled" | "disabled";
  authentication: "enabled" | "disabled";
  authenticationRequired: boolean;
};

export function serviceEnvironment(source: Readonly<Record<string, string | undefined>> = process.env): ServiceEnvironment {
  const dataMode = source.NZI_DATA_MODE === "isolated-api" ? "isolated-api" : "fixture";
  return {
    env: source.NEXT_PUBLIC_APP_ENV ?? "local",
    dataMode,
    isolation: dataMode === "fixture" ? "no-database" : "non-production-only",
    writes: source.NZI_WRITE_API_ENABLED === "true" ? "enabled" : "disabled",
    authentication: source.NZI_AUTH_ENABLED === "true" ? "enabled" : "disabled",
    authenticationRequired: source.NZI_AUTH_REQUIRED === "true",
  };
}

/** The admin badge's words: where a change made on this screen would land. */
export function environmentBadge(environment: ServiceEnvironment): { label: string; detail: string } {
  const env = environment.env.charAt(0).toUpperCase() + environment.env.slice(1);
  if (environment.dataMode === "fixture") return { label: `${env} · fixture data`, detail: "No database is connected; nothing on this screen is saved." };
  return {
    label: `${env} · isolated`,
    detail: `Reads and writes the isolated, non-production database. Writes are ${environment.writes}.`,
  };
}
