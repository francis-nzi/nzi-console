import { resetCompleteRoute } from "../../../../../lib/passwordResetRoutes";

/** Forgot password (portal sign-in, email programme phase 4-1): see passwordResetRoutes. */
export const dynamic = "force-dynamic";
export const POST = resetCompleteRoute("portal");
