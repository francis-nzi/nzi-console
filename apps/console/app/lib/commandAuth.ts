import "server-only";
import { assertSameOrigin, authorizeCommand, resolveStaffPrincipal, verifyStaffSession } from "@nzi/isolated-backend";
import type { CommandKey } from "@nzi/contracts";
import { isolatedPool } from "./isolatedDatabase";

const cookieValue = (header: string | null, name: string) => header?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);

export async function requireCommandPrincipal(request: Request, key: CommandKey) {
  if (process.env.NZI_WRITE_API_ENABLED !== "true") throw new WriteApiDisabledError();
  assertSameOrigin(request.headers.get("origin"), process.env.NZI_ISOLATED_API_URL);
  const session = verifyStaffSession(cookieValue(request.headers.get("cookie"), "nzi_console_session"), process.env.NZI_CONSOLE_SESSION_SECRET);
  const principal = await resolveStaffPrincipal(isolatedPool(), session);
  authorizeCommand(principal, key);
  return principal;
}

export class WriteApiDisabledError extends Error { constructor() { super("Write API is disabled."); this.name = "WriteApiDisabledError"; } }
