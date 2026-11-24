import { redirect } from "next/navigation";
import { adminAccess } from "../adminAccess";

export const dynamic = "force-dynamic";

/**
 * Import reconciliation is retired (BRIEF-v7-import-rows-modal §C): a job's rows from the previous system are matched, reconciled
 * and accepted in one modal from the job — "Import rows from the previous system". After the admin section's own access check, a
 * link to a job here lands on that job with the modal open; with no job, on the jobs list, where each imported job carries it.
 */
export default async function ImportReconciliationRetired({ searchParams }: { searchParams: Promise<{ job?: string }> }) {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why.
  const { job } = await searchParams;
  redirect(job ? `/jobs/${encodeURIComponent(job)}?import=rows` : "/jobs");
}
