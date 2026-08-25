import "server-only";
import { loadFixtureScreen, requestScreen, resolveDataMode } from "@nzi/api-client";
import type { ScreenKey, ScreenResult } from "@nzi/contracts";
import { headers } from "next/headers";

export async function loadScreen<T>(key: ScreenKey, fixtureValue: unknown, resource: string = key): Promise<ScreenResult<T>> {
  const data = resolveDataMode(process.env.NZI_DATA_MODE, process.env.NEXT_PUBLIC_APP_ENV, process.env.NZI_ISOLATED_API_URL);
  const requestId = crypto.randomUUID();
  if (data.mode === "fixture") return loadFixtureScreen<T>(key, fixtureValue, { requestId });
  const base = data.apiBaseUrl!.replace(/\/$/, "");
  const cookie = (await headers()).get("cookie");
  return requestScreen<T>(key, () => fetch(`${base}/api/isolated/${resource}`, { cache: "no-store", headers: { "x-request-id": requestId, ...(cookie ? { cookie } : {}) } }), { requestId });
}
