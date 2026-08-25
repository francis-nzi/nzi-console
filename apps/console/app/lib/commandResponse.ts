import "server-only";
import { AuthenticationError, AuthorizationError, CommandValidationError, IdempotencyConflictError, VersionConflictError } from "@nzi/isolated-backend";
import type { CommandContext } from "@nzi/contracts";
import { WriteApiDisabledError } from "./commandAuth";

export function commandContext(request: Request, identity: { organisationId: string; userId: string }): CommandContext {
  return {
    organisationId: identity.organisationId,
    actorId: identity.userId,
    principal: "staff",
    idempotencyKey: request.headers.get("idempotency-key")?.trim() ?? "",
    correlationId: request.headers.get("x-correlation-id")?.trim() || crypto.randomUUID(),
    reason: request.headers.get("x-command-reason")?.trim() || undefined,
  };
}

export function commandSuccess(outcome: { data: Record<string, unknown>; auditEventId: string; correlationId: string; replayed: boolean }) {
  return Response.json({ data: outcome.data, auditEventId: outcome.auditEventId, correlationId: outcome.correlationId }, { status: outcome.replayed ? 200 : 201, headers: { "x-correlation-id": outcome.correlationId, "x-idempotent-replay": String(outcome.replayed) } });
}

export function commandFailure(error: unknown) {
  if (error instanceof WriteApiDisabledError) return Response.json({ code: "WRITE_API_DISABLED", message: "Write operations are not enabled." }, { status: 503 });
  if (error instanceof AuthenticationError) return Response.json({ code: "AUTHENTICATION_REQUIRED", message: "Staff authentication is required." }, { status: 401 });
  if (error instanceof AuthorizationError) return Response.json({ code: "PERMISSION_DENIED", message: "Permission denied.", permission: error.permission }, { status: 403 });
  if (error instanceof CommandValidationError) return Response.json({ code: "VALIDATION_FAILED", message: "Command validation failed.", issues: error.issues }, { status: 422 });
  if (error instanceof VersionConflictError) return Response.json({ code: "VERSION_CONFLICT", message: "The job changed; refresh before moving its stage." }, { status: 409 });
  if (error instanceof IdempotencyConflictError) return Response.json({ code: "IDEMPOTENCY_CONFLICT", message: error.message }, { status: 409 });
  return Response.json({ code: "COMMAND_FAILED", message: "The command could not be completed." }, { status: 500 });
}
