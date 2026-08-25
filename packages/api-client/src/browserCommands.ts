export type BrowserCommandResult<T> =
  | { state: "success"; data: T; replayed: boolean }
  | { state: "conflict"; message: string }
  | { state: "validation_failed"; message: string; issues: { field: string; message: string }[] }
  | { state: "failed"; message: string; retryable: boolean };

export type BrowserCommandTransport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function sendBrowserCommand<T>(method: "POST" | "PATCH" | "PUT", path: string, input: unknown, idempotencyKey: string, transport: BrowserCommandTransport, reason?: string): Promise<BrowserCommandResult<T>> {
  try {
    const response = await transport(path, {
      method,
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "x-correlation-id": crypto.randomUUID(),
        ...(reason?.trim() ? { "x-command-reason": reason.trim() } : {}),
      },
      body: JSON.stringify(input),
    });
    const payload = await response.json().catch(() => ({})) as { data?: T; message?: string; issues?: { field: string; message: string }[] };
    if (response.ok && payload.data) return { state: "success", data: payload.data, replayed: response.headers.get("x-idempotent-replay") === "true" };
    if (response.status === 409) return { state: "conflict", message: payload.message ?? "The record changed; refresh and retry." };
    if (response.status === 422) return { state: "validation_failed", message: payload.message ?? "Check the highlighted information.", issues: payload.issues ?? [] };
    return { state: "failed", message: payload.message ?? "The change could not be saved.", retryable: response.status >= 500 };
  } catch (error) {
    return { state: "failed", message: error instanceof Error ? error.message : "The service could not be reached.", retryable: true };
  }
}

export function postBrowserCommand<T>(path: string, input: unknown, idempotencyKey: string, transport: BrowserCommandTransport = fetch) { return sendBrowserCommand<T>("POST", path, input, idempotencyKey, transport); }
export function postBrowserCommandWithReason<T>(path: string, input: unknown, idempotencyKey: string, reason: string, transport: BrowserCommandTransport = fetch) { return sendBrowserCommand<T>("POST", path, input, idempotencyKey, transport, reason); }
export function patchBrowserCommand<T>(path: string, input: unknown, idempotencyKey: string, transport: BrowserCommandTransport = fetch) { return sendBrowserCommand<T>("PATCH", path, input, idempotencyKey, transport); }
export function putBrowserCommand<T>(path: string, input: unknown, idempotencyKey: string, transport: BrowserCommandTransport = fetch) { return sendBrowserCommand<T>("PUT", path, input, idempotencyKey, transport); }
