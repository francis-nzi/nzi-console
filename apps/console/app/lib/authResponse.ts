import "server-only";
import { AuthorizationError, InvalidLoginError, LoginLockedError, PortalTermsRequiredError, TraineeInvitationError } from "@nzi/isolated-backend";
import { AuthDisabledError, AuthenticationError } from "./staffSession";
import {clearPortalSessionCookie,PortalAuthDisabledError} from "./portalSession";
import { clearTraineeSessionCookie, TraineeAuthDisabledError } from "./traineeSession";

export function portalAuthFailure(error:unknown){
  if(error instanceof PortalAuthDisabledError)return Response.json({code:"PORTAL_AUTH_DISABLED",message:"Client portal sign-in is not enabled."},{status:503});
  if(error instanceof PortalTermsRequiredError)return Response.json({code:"PORTAL_TERMS_REQUIRED",message:"Accept the portal terms of access to continue.",termsVersion:error.termsVersion},{status:403,headers:{"Cache-Control":"private, no-store"}});
  if(error instanceof AuthenticationError)return Response.json({code:"PORTAL_SESSION_ENDED",message:"Your secure session has ended. Sign in again to continue."},{status:401,headers:{"Set-Cookie":clearPortalSessionCookie(),"Cache-Control":"private, no-store"}});
  if(error instanceof AuthorizationError)return Response.json({code:"PERMISSION_DENIED",message:error.message},{status:403});
  if(error instanceof LoginLockedError)return Response.json({code:"LOGIN_LOCKED",message:error.message},{status:429});
  if(error instanceof InvalidLoginError)return Response.json({code:"INVALID_LOGIN",message:"Invalid email, password, or MFA code."},{status:401});
  return Response.json({code:"PORTAL_REQUEST_FAILED",message:"The secure portal request could not be completed."},{status:500});
}

/**
 * The trainee realm's own failure shape. It is separate from the client portal's so the
 * two can never hand each other a session-ended response that clears the wrong cookie —
 * and so a trainee is told to sign in at the trainee portal, not the client one.
 */
export function traineeAuthFailure(error: unknown) {
  if (error instanceof TraineeAuthDisabledError) return Response.json({ code: "TRAINEE_AUTH_DISABLED", message: "Trainee sign-in is not enabled." }, { status: 503 });
  if (error instanceof AuthenticationError) return Response.json({ code: "TRAINEE_SESSION_ENDED", message: "Your session has ended. Sign in again to continue." }, { status: 401, headers: { "Set-Cookie": clearTraineeSessionCookie(), "Cache-Control": "private, no-store" } });
  if (error instanceof LoginLockedError) return Response.json({ code: "LOGIN_LOCKED", message: error.message }, { status: 429 });
  if (error instanceof InvalidLoginError) return Response.json({ code: "INVALID_LOGIN", message: "Invalid email, password, or MFA code." }, { status: 401 });
  // The invitation/email-change errors are written for the person reading them, so they
  // are passed through rather than flattened into a generic failure.
  if (error instanceof TraineeInvitationError) return Response.json({ code: "TRAINEE_REQUEST_REJECTED", message: error.message }, { status: 400 });
  if (error instanceof AuthorizationError) return Response.json({ code: "PERMISSION_DENIED", message: error.message }, { status: 403 });
  return Response.json({ code: "TRAINEE_REQUEST_FAILED", message: "The request could not be completed." }, { status: 500 });
}

export function authFailure(error: unknown) {
  if (error instanceof AuthDisabledError) return Response.json({ code: "AUTH_DISABLED", message: "Staff sign-in is not enabled." }, { status: 503 });
  if(error instanceof PortalAuthDisabledError)return Response.json({code:"PORTAL_AUTH_DISABLED",message:"Client portal sign-in is not enabled."},{status:503});
  if (error instanceof AuthorizationError) return Response.json({ code: "PERMISSION_DENIED", message: error.message }, { status: 403 });
  if (error instanceof LoginLockedError) return Response.json({ code: "LOGIN_LOCKED", message: error.message }, { status: 429 });
  if (error instanceof InvalidLoginError || error instanceof AuthenticationError) return Response.json({ code: "INVALID_LOGIN", message: "Invalid email, password, or MFA code." }, { status: 401 });
  return Response.json({ code: "AUTH_FAILED", message: "Sign-in could not be completed." }, { status: 500 });
}
