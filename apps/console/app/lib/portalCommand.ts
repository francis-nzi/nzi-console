import "server-only";
import { CommandValidationError, IdempotencyConflictError, VersionConflictError, type PortalPrincipal } from "@nzi/isolated-backend";
import type { PortalCommandContext } from "@nzi/contracts";
import { commandReason, CommandReasonEncodingError } from "@nzi/api-client";
import { portalAuthFailure } from "./authResponse";
import { commandFailure } from "./commandResponse";
import { portalFeatureEnabled } from "./portalFlags";

/**
 * Portal data-entry phase 2: a client's command runs as the resolved portal principal — its tenant, its user and its client.
 * It carries no grant: the runner authorizes a portal command by the user's access grant on the job and its open window, and
 * the handler by the client's profile (`portalCapture.ts`). The idempotency key and correlation id come from the request, as
 * a member of staff's do.
 */
export function portalCommandContext(request: Request, user: PortalPrincipal): PortalCommandContext {
  return {
    organisationId: user.organisationId,
    actorId: user.userId,
    principal: "portal",
    portal: { portalUserId: user.userId, clientId: user.clientId },
    idempotencyKey: request.headers.get("idempotency-key")?.trim() ?? "",
    correlationId: request.headers.get("x-correlation-id")?.trim() || crypto.randomUUID(),
    reason: commandReason(request.headers),
  };
}

/** A command's own refusals as a staff command's are; everything else (session, terms, access) as the portal's. */
export function portalCommandFailure(error: unknown): Response {
  if (error instanceof CommandValidationError || error instanceof VersionConflictError || error instanceof IdempotencyConflictError || error instanceof CommandReasonEncodingError) return commandFailure(error);
  return portalAuthFailure(error);
}

/** The Data view and its routes are dark until `portal-data` is on (dark by absence, as #503 established). */
export class PortalDataOffError extends Error { constructor() { super("Not found."); this.name = "PortalDataOffError"; } }
export function requirePortalData(): void { if (!portalFeatureEnabled("portal-data")) throw new PortalDataOffError(); }
export const portalDataOff = () => Response.json({ code: "NOT_FOUND", message: "Not found." }, { status: 404 });
