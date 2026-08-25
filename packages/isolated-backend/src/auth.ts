import { createHmac, timingSafeEqual } from "node:crypto";
import type { CommandKey } from "@nzi/contracts";
import { commandDefinitions } from "@nzi/contracts";
import type { PoolLike, Queryable } from "./postgres";
import { withAuthTransaction } from "./postgres";

export type StaffRole = "administrator" | "consultant" | "reviewer" | "finance" | "methodology-data-admin" | "read-only";
export type StaffPermission =
  | "clients.create" | "jobs.create" | "jobs.stage.change" | "emissions.review" | "reports.publish"
  | "datasets.override" | "portal.access.manage" | "sales.convert" | "finance.manage" | "staff.access.manage";
export type StaffSession = { sessionId: string; userId: string; organisationId: string; issuedAt: number; expiresAt: number };
export type StaffPrincipal = StaffSession & { role: StaffRole; permissions: readonly StaffPermission[] };

export const rolePermissions: Record<StaffRole, readonly StaffPermission[]> = {
  administrator: ["clients.create", "jobs.create", "jobs.stage.change", "emissions.review", "reports.publish", "datasets.override", "portal.access.manage", "sales.convert", "finance.manage", "staff.access.manage"],
  consultant: ["clients.create", "jobs.create", "jobs.stage.change", "sales.convert"],
  reviewer: ["jobs.stage.change", "emissions.review", "reports.publish", "portal.access.manage"],
  finance: ["finance.manage"],
  "methodology-data-admin": ["datasets.override"],
  "read-only": [],
};

export class AuthenticationError extends Error { constructor(message = "Staff authentication is required.") { super(message); this.name = "AuthenticationError"; } }
export class AuthorizationError extends Error { constructor(readonly permission: string) { super("Permission denied."); this.name = "AuthorizationError"; } }

const encode = (value: string) => Buffer.from(value).toString("base64url");
const sign = (payload: string, secret: string) => createHmac("sha256", secret).update(payload).digest("base64url");
const requireSecret = (secret: string | undefined) => {
  if (!secret || Buffer.byteLength(secret) < 32) throw new AuthenticationError("A dedicated session secret of at least 32 bytes is required.");
  return secret;
};

export function issueStaffSession(session: StaffSession, secret: string): string {
  const payload = encode(JSON.stringify(session));
  return `${payload}.${sign(payload, requireSecret(secret))}`;
}

export function verifyStaffSession(token: string | undefined, secret: string | undefined, nowSeconds = Math.floor(Date.now() / 1000)): StaffSession {
  if (!token) throw new AuthenticationError();
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) throw new AuthenticationError("Invalid staff session.");
  const expected = sign(payload, requireSecret(secret));
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) throw new AuthenticationError("Invalid staff session.");
  let session: StaffSession;
  try { session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as StaffSession; } catch { throw new AuthenticationError("Invalid staff session."); }
  if (!session.sessionId?.trim() || !session.userId?.trim() || !session.organisationId?.trim() || !Number.isInteger(session.issuedAt) || !Number.isInteger(session.expiresAt)) throw new AuthenticationError("Invalid staff session.");
  if (session.issuedAt > nowSeconds + 60 || session.expiresAt <= nowSeconds) throw new AuthenticationError("Staff session has expired.");
  return session;
}

export async function resolveStaffPrincipal(pool: PoolLike, session: StaffSession): Promise<StaffPrincipal> {
  return withAuthTransaction(pool, "read", async (db: Queryable) => {
    const result = await db.query<{ role_id: StaffRole }>(`SELECT m.role_id FROM nzi_console.staff_sessions s
      JOIN nzi_console.memberships m ON (m.organisation_id, m.user_id) = (s.organisation_id, s.user_id)
      WHERE s.organisation_id=$1 AND s.session_id=$2 AND s.user_id=$3 AND s.revoked_at IS NULL
        AND s.expires_at > now() AND m.status='active'`, [session.organisationId, session.sessionId, session.userId]);
    const role = result.rows[0]?.role_id;
    if (!role || !(role in rolePermissions)) throw new AuthenticationError("No active staff membership exists.");
    return { ...session, role, permissions: rolePermissions[role] };
  });
}

export function authorizeCommand(principal: StaffPrincipal, key: CommandKey): void {
  const permission = commandDefinitions[key].permission as StaffPermission;
  if (!principal.permissions.includes(permission)) throw new AuthorizationError(permission);
}

export function assertSameOrigin(origin: string | null, configuredBaseUrl: string | undefined): void {
  if (!origin || !configuredBaseUrl) throw new AuthenticationError("A trusted request origin is required.");
  if (new URL(origin).origin !== new URL(configuredBaseUrl).origin) throw new AuthenticationError("Request origin is not trusted.");
}
