export type BrowserCommandResult<T> =
  | { state: "success"; data: T; replayed: boolean }
  | { state: "conflict"; message: string }
  | { state: "validation_failed"; message: string; issues: { field: string; message: string }[] }
  | { state: "failed"; message: string; retryable: boolean };

export type BrowserCommandTransport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function postBrowserCommand<T>(path: string, input: unknown, idempotencyKey: string, transport: BrowserCommandTransport = fetch): Promise<BrowserCommandResult<T>> {
  try {
    const response = await transport(path, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "x-correlation-id": crypto.randomUUID(),
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
