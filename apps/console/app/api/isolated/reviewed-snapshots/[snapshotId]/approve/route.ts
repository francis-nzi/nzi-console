import { approveReviewedCrpSnapshot } from "@nzi/isolated-backend";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// NZC-022 — snapshot.review, by anyone except the snapshot's preparer (checked in the command).
export async function POST(request: Request, { params }: { params: Promise<{ snapshotId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "report.snapshot.approve");
    const { snapshotId } = await params;
    const body = await request.json().catch(() => ({})) as { note?: unknown };
    return commandSuccess(await approveReviewedCrpSnapshot(isolatedPool(), { reviewedSnapshotId: snapshotId, note: typeof body.note === "string" ? body.note : null }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
