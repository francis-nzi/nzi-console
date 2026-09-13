import "server-only";
import {
  assertSameOrigin, issueTraineeSession, resolveTraineePrincipal, revokeTraineeSession,
  verifyTraineeSession,
} from "@nzi/isolated-backend";
import { isolatedPool } from "./isolatedDatabase";

/**
 * The trainee realm — the third identity on the platform, alongside staff and client
 * portal users.
 *
 * It is a realm of its own rather than a role inside the client portal because a trainee
 * is a *person*, not an employee of a client: their record follows them between employers
 * and their sign-in is their personal email. A cookie named separately, a secret of its
 * own, and no shared session shape are what stop a client portal session from ever
 * resolving to a trainee, or the reverse.
 */

export const TRAINEE_SESSION_COOKIE = "nzi_trainee_session";

const cookieValue = (header: string | null, name: string) =>
  header?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);

export const traineeSessionCookie = (token: string, maxAge: number) =>
  `${TRAINEE_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
export const clearTraineeSessionCookie = () =>
  `${TRAINEE_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export class TraineeAuthDisabledError extends Error {
  constructor() { super("Trainee portal authentication is disabled."); this.name = "TraineeAuthDisabledError"; }
}

export const requireTraineeAuthEnabled = () => {
  if (process.env.NZI_TRAINEE_AUTH_ENABLED !== "true") throw new TraineeAuthDisabledError();
};
export const requireTraineeOrigin = (request: Request) =>
  assertSameOrigin(request.headers.get("origin"), process.env.NZI_ISOLATED_API_URL);

export const signTraineeSession = (session: Parameters<typeof issueTraineeSession>[0]) =>
  issueTraineeSession(session, process.env.NZI_TRAINEE_SESSION_SECRET ?? "");

export const traineeIdleLimitMinutes = () => {
  const parsed = Number(process.env.NZI_TRAINEE_IDLE_LIMIT_MINUTES);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 30;
};

/** Every trainee data route goes through this — the person is the session, never a parameter. */
export async function currentTrainee(request: Request) {
  requireTraineeAuthEnabled();
  const session = verifyTraineeSession(cookieValue(request.headers.get("cookie"), TRAINEE_SESSION_COOKIE), process.env.NZI_TRAINEE_SESSION_SECRET);
  return resolveTraineePrincipal(isolatedPool(), session, { idleLimitMinutes: traineeIdleLimitMinutes() });
}

export async function endTraineeSession(request: Request) {
  const session = verifyTraineeSession(cookieValue(request.headers.get("cookie"), TRAINEE_SESSION_COOKIE), process.env.NZI_TRAINEE_SESSION_SECRET);
  await revokeTraineeSession(isolatedPool(), session);
}
