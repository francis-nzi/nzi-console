import { commandDefinitions, validateCommand, type CommandContext, type CommandInputMap, type CommandKey, type CommandOutcome } from "@nzi/contracts";

export type CommandRequest<K extends CommandKey> = { key: K; input: CommandInputMap[K]; context: CommandContext; permission: string; auditAction: string };
export type CommandTransport = <K extends CommandKey>(request: CommandRequest<K>) => Promise<Response>;

export async function executeCommand<K extends CommandKey, T = Record<string, unknown>>(key: K, input: CommandInputMap[K], context: CommandContext, transport: CommandTransport): Promise<CommandOutcome<T>> {
  const issues = validateCommand(key, input, context);
  if (issues.length) return { state: "validation_failed", issues, correlationId: context.correlationId };
  const definition = commandDefinitions[key];
  try {
    const response = await transport({ key, input, context, permission: definition.permission, auditAction: definition.auditAction });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.status === 403) return { state: "denied", permission: definition.permission, message: String(payload.message ?? "Permission denied."), correlationId: context.correlationId };
    if (response.status === 409) return { state: "conflict", code: String(payload.code ?? "VERSION_CONFLICT"), message: String(payload.message ?? "Record changed; refresh and retry."), correlationId: context.correlationId };
    if (!response.ok) return { state: "failed", code: String(payload.code ?? `HTTP_${response.status}`), message: String(payload.message ?? "Command failed."), retryable: response.status >= 500, correlationId: context.correlationId };
    return { state: "success", data: payload.data as T, auditEventId: String(payload.auditEventId ?? ""), correlationId: context.correlationId, replayed: response.headers.get("x-idempotent-replay") === "true" };
  } catch (error) {
    return { state: "failed", code: "NETWORK_ERROR", message: error instanceof Error ? error.message : "Command transport failed.", retryable: true, correlationId: context.correlationId };
  }
}
