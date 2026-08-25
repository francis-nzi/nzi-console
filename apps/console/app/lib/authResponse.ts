import "server-only";
import { InvalidLoginError, LoginLockedError } from "@nzi/isolated-backend";
import { AuthDisabledError, AuthenticationError } from "./staffSession";

export function authFailure(error: unknown) {
  if (error instanceof AuthDisabledError) return Response.json({ code: "AUTH_DISABLED", message: "Staff sign-in is not enabled." }, { status: 503 });
  if (error instanceof LoginLockedError) return Response.json({ code: "LOGIN_LOCKED", message: error.message }, { status: 429 });
  if (error instanceof InvalidLoginError || error instanceof AuthenticationError) return Response.json({ code: "INVALID_LOGIN", message: "Invalid email, password, or MFA code." }, { status: 401 });
  return Response.json({ code: "AUTH_FAILED", message: "Sign-in could not be completed." }, { status: 500 });
}
