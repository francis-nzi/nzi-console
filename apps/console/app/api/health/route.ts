export const dynamic = "force-dynamic";

export function GET() {
  const dataMode = process.env.NZI_DATA_MODE === "isolated-api" ? "isolated-api" : "fixture";
  return Response.json({
    status: "ok",
    app: "nzi-console",
    env: process.env.NEXT_PUBLIC_APP_ENV ?? "local",
    dataMode,
    isolation: dataMode === "fixture" ? "no-database" : "non-production-only",
    writes: process.env.NZI_WRITE_API_ENABLED === "true" ? "enabled" : "disabled",
    time: new Date().toISOString(),
  });
}
