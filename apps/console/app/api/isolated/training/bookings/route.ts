import { createTrainingBooking, setTrainingAttendance } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Book a person onto a run (training.manage). Where a place funds it, the place is reserved
// in the same transaction, so a booking never exists without the place it claimed.
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "training.booking.create");
    const body = await request.json() as CommandInputMap["training.booking.create"];
    return commandSuccess(await createTrainingBooking(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}

// Mark one person at one session (training.manage). The percentage is always derived.
export async function PUT(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "training.attendance.set");
    const body = await request.json() as CommandInputMap["training.attendance.set"];
    return commandSuccess(await setTrainingAttendance(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
