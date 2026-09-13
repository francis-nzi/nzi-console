import { issueTrainingCertificates, reviewTrainingRun, setTrainingRunStage } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// The run's own stage machine (training.manage) — one step at a time, like every stage
// machine on the spine.
export async function PATCH(request: Request, { params }: { params: Promise<{ courseRunId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "training.run.stage.set");
    const { courseRunId } = await params;
    const body = await request.json() as Omit<CommandInputMap["training.run.stage.set"], "courseRunId">;
    return commandSuccess(await setTrainingRunStage(isolatedPool(), { ...body, courseRunId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}

// Issue every certificate the policy allows (training.manage). Attendance decides, consent
// holds: the capability says who may run this, the policy decides who gets one.
export async function POST(request: Request, { params }: { params: Promise<{ courseRunId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "training.certificate.issue");
    const { courseRunId } = await params;
    const body = await request.json() as Omit<CommandInputMap["training.certificate.issue"], "courseRunId">;
    return commandSuccess(await issueTrainingCertificates(isolatedPool(), { ...body, courseRunId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}

// Reviewing freezes the register and its certificates (snapshot.review — deliberately NOT
// training.manage, so the person who delivered and issued does not self-approve).
export async function PUT(request: Request, { params }: { params: Promise<{ courseRunId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "training.run.review");
    const { courseRunId } = await params;
    const body = await request.json() as Omit<CommandInputMap["training.run.review"], "courseRunId">;
    return commandSuccess(await reviewTrainingRun(isolatedPool(), { ...body, courseRunId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
