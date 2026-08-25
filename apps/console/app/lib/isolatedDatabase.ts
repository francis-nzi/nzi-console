import "server-only";
import { createIsolatedPool } from "@nzi/isolated-backend";

const globalPool = globalThis as typeof globalThis & { nziIsolatedPool?: ReturnType<typeof createIsolatedPool> };

export function requireIsolatedApiContext() {
  if (process.env.NZI_DATA_MODE !== "isolated-api") throw new Error("Isolated API routes are disabled while fixture mode is active.");
  const organisationId = process.env.NZI_DEMO_ORGANISATION_ID?.trim();
  if (!organisationId) throw new Error("NZI_DEMO_ORGANISATION_ID is required for isolated API mode.");
  return { organisationId, pool: isolatedPool() };
}

export function isolatedPool() {
  if (!globalPool.nziIsolatedPool) {
    globalPool.nziIsolatedPool = createIsolatedPool({
      appEnv: process.env.NEXT_PUBLIC_APP_ENV,
      boundaryToken: process.env.NZI_DATABASE_BOUNDARY,
      isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
    });
  }
  return globalPool.nziIsolatedPool;
}

export function apiFailure(error: unknown) {
  const correlationId = crypto.randomUUID();
  void error;
  return Response.json({ type: "about:blank", title: "Isolated API unavailable", status: 503, detail: "The isolated data service is unavailable.", correlationId }, { status: 503, headers: { "x-correlation-id": correlationId } });
}
