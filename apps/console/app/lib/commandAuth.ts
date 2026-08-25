import "server-only";
import { authorizeCommand } from "@nzi/isolated-backend";
import type { CommandKey } from "@nzi/contracts";
import { currentStaff, requireAuthOrigin } from "./staffSession";

export async function requireCommandPrincipal(request: Request, key: CommandKey) {
  if (process.env.NZI_WRITE_API_ENABLED !== "true") throw new WriteApiDisabledError();
  requireAuthOrigin(request);
  const principal = await currentStaff(request);
  authorizeCommand(principal, key);
  return principal;
}

export class WriteApiDisabledError extends Error { constructor() { super("Write API is disabled."); this.name = "WriteApiDisabledError"; } }
