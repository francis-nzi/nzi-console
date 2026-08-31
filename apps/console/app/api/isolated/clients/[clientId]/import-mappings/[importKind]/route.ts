import { getClientImportMapping, saveClientImportMapping, withTenantRead } from "@nzi/isolated-backend";
import type { SpendImportColumnMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../lib/commandResponse";
import { apiFailure, isolatedPool, requireIsolatedApiContext } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

const kindOf = (value: string): "spend" | null => (value === "spend" ? "spend" : null);

export async function GET(_request: Request, { params }: { params: Promise<{ clientId: string; importKind: string }> }) {
  try {
    const { clientId, importKind } = await params;
    const kind = kindOf(importKind);
    if (!kind) return Response.json({ code: "UNKNOWN_KIND", message: "Unknown import kind." }, { status: 404 });
    const { pool, organisationId } = requireIsolatedApiContext();
    const mapping = await withTenantRead(pool, organisationId, (db) => getClientImportMapping(db, organisationId, clientId, kind));
    return Response.json({ mapping });
  } catch (error) {
    return apiFailure(error);
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ clientId: string; importKind: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.import.mapping.save");
    const { clientId, importKind } = await params;
    const kind = kindOf(importKind);
    if (!kind) return commandFailure(new Error("Unknown import kind."));
    const body = (await request.json()) as { columns?: SpendImportColumnMap };
    return commandSuccess(await saveClientImportMapping(isolatedPool(), { clientId, importKind: kind, columns: body.columns ?? {} }, commandContext(request, principal)));
  } catch (error) {
    return commandFailure(error);
  }
}
