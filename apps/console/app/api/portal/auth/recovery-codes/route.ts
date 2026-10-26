import { recoveryCodeRoutes } from "../../../../lib/recoveryCodeRoutes";

/** MFA recovery codes for the signed-in portal user (email programme phase 4-2): see recoveryCodeRoutes. */
export const dynamic = "force-dynamic";
const routes = recoveryCodeRoutes("portal");
export const GET = routes.GET;
export const POST = routes.POST;
