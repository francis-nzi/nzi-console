import { contractFor, type ScreenIssue, type ScreenKey, type ScreenMeta, type ScreenResult } from "@nzi/contracts";

export type LoadOptions = { requestId?: string; warning?: ScreenIssue; now?: () => Date };
export type DataMode = "fixture" | "isolated-api";
export function resolveDataMode(value: string | undefined, appEnv: string | undefined, apiBaseUrl?: string): { mode: DataMode; apiBaseUrl?: string } {
  const mode: DataMode = value === "isolated-api" ? "isolated-api" : "fixture";
  if (appEnv === "production" && mode === "isolated-api") throw new Error("NZI Console may not connect to an API while APP_ENV is production.");
  if (mode === "isolated-api" && !apiBaseUrl?.trim()) throw new Error("Isolated API mode requires NZI_ISOLATED_API_URL.");
  return { mode, ...(mode === "isolated-api" ? { apiBaseUrl } : {}) };
}
function meta(key: ScreenKey, source: ScreenMeta["source"], options: LoadOptions): ScreenMeta { return { contract: key, source, requestId: options.requestId ?? `${key}-local`, receivedAt: (options.now?.() ?? new Date()).toISOString() }; }

export function loadFixtureScreen<T>(key: ScreenKey, value: unknown, options: LoadOptions = {}): ScreenResult<T> {
  const screenMeta = meta(key, "fixture", options);
  const contract = contractFor<T>(key);
  if (!contract.validate(value)) return { state: "failed", meta: screenMeta, error: { code: "CONTRACT_INVALID", message: `Response does not satisfy the ${key} screen contract.`, retryable: false, correlationId: screenMeta.requestId } };
  const data = value as T;
  if (contract.isEmpty(data)) return { state: "empty", meta: screenMeta, message: "No records match this view." };
  if (options.warning) return { state: "degraded", meta: screenMeta, data, warning: options.warning };
  return { state: "success", meta: screenMeta, data };
}

export async function requestScreen<T>(key: ScreenKey, request: () => Promise<Response>, options: LoadOptions = {}): Promise<ScreenResult<T>> {
  const screenMeta = meta(key, "api", options);
  try {
    const response = await request();
    if (!response.ok) return { state: "failed", meta: screenMeta, error: { code: `HTTP_${response.status}`, message: `Request failed with status ${response.status}.`, retryable: response.status >= 500, correlationId: response.headers.get("x-correlation-id") ?? screenMeta.requestId } };
    const value: unknown = await response.json();
    const contract = contractFor<T>(key);
    if (!contract.validate(value)) return { state: "failed", meta: screenMeta, error: { code: "CONTRACT_INVALID", message: `Response does not satisfy the ${key} screen contract.`, retryable: false, correlationId: screenMeta.requestId } };
    const data = value as T;
    if (contract.isEmpty(data)) return { state: "empty", meta: screenMeta, message: "No records match this view." };
    const warning = response.headers.get("x-nzi-warning");
    return warning ? { state: "degraded", meta: screenMeta, data, warning: { code: "UPSTREAM_DEGRADED", message: warning, retryable: true, correlationId: screenMeta.requestId } } : { state: "success", meta: screenMeta, data };
  } catch (error) {
    return { state: "failed", meta: screenMeta, error: { code: "NETWORK_ERROR", message: error instanceof Error ? error.message : "Network request failed.", retryable: true, correlationId: screenMeta.requestId } };
  }
}
export * from "./commands";
