import { setJobFee } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** A job's fee, ex VAT (Time PR B, ⚑5/⚑6) — finance.manage; the amount never enters a payload (NZC-120). */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job.fee.set");
    const { jobId } = await params;
    const body = await request.json() as Omit<CommandInputMap["job.fee.set"], "jobId">;
    return commandSuccess(await setJobFee(isolatedPool(), { ...body, jobId: decodeURIComponent(jobId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
