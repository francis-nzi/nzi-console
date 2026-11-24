import { requireCapability, searchV7ImportFactors } from "@nzi/isolated-backend";
import { commandFailure } from "../../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/**
 * The import rows modal's factor search (BRIEF-v7-import-rows-modal §D): the library by any words of a factor's ID, label, unit
 * and dataset, in any order — `import.refresh`, on the job. A read of the library: the body names the words and the row's unit,
 * nothing else of the row, and the modal judges each hit against the row it already holds. POST only so the words stay out of
 * the URL.
 */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const principal = await currentStaff(request);
    requireCapability(principal, "import.refresh");
    const body = await request.json().catch(() => null) as { query?: unknown; unit?: unknown } | null;
    const query = typeof body?.query === "string" ? body.query : "";
    const unit = typeof body?.unit === "string" && body.unit.trim() ? body.unit : null;
    const data = await searchV7ImportFactors(isolatedPool(), principal, { jobId, query, unit });
    return Response.json({ data }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return commandFailure(error); }
}
