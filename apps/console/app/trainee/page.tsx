import { TraineeWorkspace } from "./TraineeWorkspace";

export const dynamic = "force-dynamic";

/**
 * The trainee portal. The page carries no identity of its own — whose record this is comes
 * from the session, resolved server-side in `/api/trainee/training`. There is no trainee id
 * in this URL, so there is none to change.
 */
export default function TraineePage() {
  return <main className="nz-portal-home"><TraineeWorkspace /></main>;
}
