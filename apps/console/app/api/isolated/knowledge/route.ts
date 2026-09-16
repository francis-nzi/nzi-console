import { captureKnowledge, findSimilarKnowledge, listKnowledgeEntries, listKnowledgeQueue, withTenantRead } from "@nzi/isolated-backend";
import type { CommandInputMap, KnowledgeStatus } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { apiFailure, isolatedPool, requireIsolatedApiContext } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * The knowledge library — NZI-wide, not per-client.
 *
 * `GET` serves three reads off one route because they are three views of one collection:
 * the approved library, the review queue, and the similarity lookup capture uses **before**
 * creating a draft. That last one is the whole duplicate-handling design: the candidates are
 * surfaced to a person, who decides.
 *
 * `POST` captures — idempotently. A second capture of the same answer by the same person
 * reopens their existing draft rather than creating a rival.
 */
export async function GET(request: Request) {
  try {
    const { pool, organisationId } = requireIsolatedApiContext();
    const url = new URL(request.url);
    const similar = url.searchParams.get("similar");
    const status = url.searchParams.get("status");
    const result = await withTenantRead(pool, organisationId, async (db) => {
      if (similar !== null) return { candidates: await findSimilarKnowledge(db, similar) };
      if (url.searchParams.get("queue") === "1") return { entries: await listKnowledgeQueue(db) };
      return { entries: await listKnowledgeEntries(db, status ? { status: status as KnowledgeStatus } : undefined) };
    });
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiFailure(error); }
}

export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "knowledge.capture");
    const body = await request.json() as CommandInputMap["knowledge.capture"];
    return commandSuccess(await captureKnowledge(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
