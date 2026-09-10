import { getCommercialDocumentHistory, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";
export async function GET(_: Request, { params }: { params: Promise<{ documentType: "quote" | "invoice" | "credit_note"; documentId: string }> }) {
  try { const { documentType, documentId } = await params; const { pool, organisationId } = requireIsolatedApiContext(); const history = await withTenantRead(pool, organisationId, (db) => getCommercialDocumentHistory(db, documentType, documentId)); return history ? Response.json(history) : new Response("Not found", { status: 404 }); } catch (error) { return apiFailure(error); }
}