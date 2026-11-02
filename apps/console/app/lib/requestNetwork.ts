import "server-only";

/**
 * The network data of a sign-in attempt, for the login record (RULING-portal-access-model Q4): the client address as the platform's proxy
 * reports it, and the user-agent. Both are personal data — kept 90 days, then nulled — and used for nothing but that record. Bounded here
 * so a hostile header cannot fill the table.
 */
export function requestNetwork(request: Request): { ip: string | null; userAgent: string | null } {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip")?.trim() || null;
  const userAgent = request.headers.get("user-agent")?.trim() || null;
  return { ip: forwarded ? forwarded.slice(0, 64) : null, userAgent: userAgent ? userAgent.slice(0, 300) : null };
}
