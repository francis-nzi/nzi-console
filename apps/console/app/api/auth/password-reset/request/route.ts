import { resetRequestRoute } from "../../../../lib/passwordResetRoutes";

/** Forgot password (staff sign-in, email programme phase 4-1): see passwordResetRoutes. */
export const dynamic = "force-dynamic";
export const POST = resetRequestRoute("staff");
