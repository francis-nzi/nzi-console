import {
  addKnowledgeAlias, approveKnowledge, editKnowledge, mergeKnowledge, publishKnowledge, rejectKnowledge,
} from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * One entry's transitions. Each is its own command with its own capability — approval and
 * publication are separate because they are separate risks, and the route must not blur
 * that by accepting a target status from the caller.
 */
type Action =
  | { action: "approve" } | { action: "publish" }
  | { action: "reject"; reason: string; duplicateOfEntryId?: string | null }
  | { action: "merge"; intoEntryId: string }
  | { action: "alias"; question: string };

export async function POST(request: Request, { params }: { params: Promise<{ entryId: string }> }) {
  try {
    const { entryId } = await params;
    const body = await request.json() as Action & { expectedVersion: number };
    const pool = isolatedPool();

    // The capability is chosen by the action, not supplied by the caller — a request cannot
    // ask to be checked against a weaker one.
    switch (body.action) {
      case "approve": {
        const principal = await requireCommandPrincipal(request, "knowledge.approve");
        return commandSuccess(await approveKnowledge(pool, { entryId, expectedVersion: body.expectedVersion }, commandContext(request, principal)));
      }
      case "publish": {
        const principal = await requireCommandPrincipal(request, "knowledge.publish");
        return commandSuccess(await publishKnowledge(pool, { entryId, expectedVersion: body.expectedVersion }, commandContext(request, principal)));
      }
      case "reject": {
        const principal = await requireCommandPrincipal(request, "knowledge.reject");
        return commandSuccess(await rejectKnowledge(pool, { entryId, expectedVersion: body.expectedVersion, reason: body.reason, duplicateOfEntryId: body.duplicateOfEntryId ?? null }, commandContext(request, principal)));
      }
      case "merge": {
        const principal = await requireCommandPrincipal(request, "knowledge.merge");
        return commandSuccess(await mergeKnowledge(pool, { entryId, expectedVersion: body.expectedVersion, intoEntryId: body.intoEntryId }, commandContext(request, principal)));
      }
      case "alias": {
        const principal = await requireCommandPrincipal(request, "knowledge.alias.add");
        return commandSuccess(await addKnowledgeAlias(pool, { entryId, expectedVersion: body.expectedVersion, question: body.question }, commandContext(request, principal)));
      }
    }
  } catch (error) { return commandFailure(error); }
}

/** Editing the text of an entry — the approver's own correction. */
export async function PATCH(request: Request, { params }: { params: Promise<{ entryId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "knowledge.edit");
    const { entryId } = await params;
    const body = await request.json() as Omit<CommandInputMap["knowledge.edit"], "entryId">;
    return commandSuccess(await editKnowledge(isolatedPool(), { ...body, entryId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
