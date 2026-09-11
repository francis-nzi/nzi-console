import { getCommercialDocumentHistory, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";
type CommercialDocumentType = "quote" | "invoice" | "credit_note";

function isCommercialDocumentType(value: string): value is CommercialDocumentType {
  return value === "quote" || value === "invoice" || value === "credit_note";
}

export async function GET(_: Request, { params }: { params: Promise<{ documentType: string; documentId: string }> }) {
  try {
    const { documentType, documentId } = await params;
    if (!isCommercialDocumentType(documentType)) return new Response("Unsupported document type", { status: 400 });
    const { pool, organisationId } = requireIsolatedApiContext();
    const history = await withTenantRead(pool, organisationId, (db) => getCommercialDocumentHistory(db, documentType, documentId));
    return history ? Response.json(history) : new Response("Not found", { status: 404 });
  } catch (error) { return apiFailure(error); }
}