import "server-only";
import { AuthenticationError, assertSameOrigin, issueStaffSession, resolveStaffPrincipal, revokeStaffSession, verifyStaffSession } from "@nzi/isolated-backend";
import { isolatedPool } from "./isolatedDatabase";

export const SESSION_COOKIE = "nzi_console_session";
const cookieValue = (header: string | null, name: string) => header?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);
export const sessionCookie = (token: string, maxAge: number) => `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
export const clearSessionCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
export const requireAuthEnabled = () => { if (process.env.NZI_AUTH_ENABLED !== "true") throw new AuthDisabledError(); };
export const requireAuthOrigin = (request: Request) => assertSameOrigin(request.headers.get("origin"), process.env.NZI_ISOLATED_API_URL);

export async function currentStaff(request: Request) {
  requireAuthEnabled();
  const session = verifyStaffSession(cookieValue(request.headers.get("cookie"), SESSION_COOKIE), process.env.NZI_CONSOLE_SESSION_SECRET);
  return resolveStaffPrincipal(isolatedPool(), session);
}

export async function endStaffSession(request: Request) {
  const session = verifyStaffSession(cookieValue(request.headers.get("cookie"), SESSION_COOKIE), process.env.NZI_CONSOLE_SESSION_SECRET);
  await revokeStaffSession(isolatedPool(), session);
}

export const signStaffSession = (session: Parameters<typeof issueStaffSession>[0]) => issueStaffSession(session, process.env.NZI_CONSOLE_SESSION_SECRET ?? "");
export class AuthDisabledError extends Error { constructor() { super("Staff authentication is disabled."); this.name = "AuthDisabledError"; } }
export { AuthenticationError };
