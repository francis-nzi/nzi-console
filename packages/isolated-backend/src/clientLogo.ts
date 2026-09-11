// The client logo (client.edit). PNG or SVG, held in the isolated non-production
// database — staging storage only, never the repo. Shown on the client record, the
// portal and published reports; each falls back to the monogram when there is none.
import { createHash, randomUUID } from "node:crypto";
import { CLIENT_LOGO_MAX_BYTES, type ClientLogoContentType, type CommandContext, type CommandInputMap } from "@nzi/contracts";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// An SVG is a document, not just an image: refuse anything that could run script or
// pull in another resource if the file were ever opened directly.
const UNSAFE_SVG = /<script\b|<foreignObject\b|<iframe\b|<embed\b|<object\b|\bon[a-z]+\s*=|javascript:|data:text\/html|<!ENTITY|(?:xlink:)?href\s*=\s*["'](?!#)/i;

/** Decodes and checks an upload; the issues are the user-facing reasons it was refused. */
export function inspectClientLogo(contentType: ClientLogoContentType, dataBase64: string): { bytes: Buffer; issues: string[] } {
  const bytes = Buffer.from(dataBase64, "base64");
  const issues: string[] = [];
  if (bytes.length === 0) issues.push("The logo file is empty.");
  if (bytes.length > CLIENT_LOGO_MAX_BYTES) issues.push(`The logo must be ${CLIENT_LOGO_MAX_BYTES / 1024} KB or smaller.`);
  if (contentType === "image/png" && !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) issues.push("The file is not a PNG image.");
  if (contentType === "image/svg+xml") {
    const text = bytes.toString("utf8");
    if (!/<svg[\s>]/i.test(text)) issues.push("The file is not an SVG image.");
    else if (UNSAFE_SVG.test(text)) issues.push("The SVG contains scripts or external references; export a plain SVG and try again.");
  }
  return { bytes, issues };
}

export type ClientLogoResult = { clientId: string; assetId: string | null; byteSize?: number; sha256?: string };

export function setClientLogo(pool: PoolLike, input: CommandInputMap["client.logo.set"], context: CommandContext): Promise<StoredOutcome<ClientLogoResult>> {
  return runPostgresCommand(pool, "client.logo.set", input, context, async (db) => {
    const { bytes, issues } = inspectClientLogo(input.contentType, input.dataBase64);
    if (issues.length) throw new CommandValidationError(issues.map((message) => ({ field: "dataBase64", code: "INVALID_LOGO", message })));
    const assetId = randomUUID();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const prior = await db.query<{ logo_asset_id: string | null }>(`SELECT logo_asset_id FROM nzi_console.clients WHERE organisation_id=$1 AND client_id=$2 FOR UPDATE`, [context.organisationId, input.clientId]);
    await db.query(
      `INSERT INTO nzi_console.client_logo_assets (organisation_id,asset_id,client_id,file_name,content_type,byte_size,sha256,content,uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [context.organisationId, assetId, input.clientId, input.fileName.trim().slice(0, 200), input.contentType, bytes.length, sha256, bytes, context.actorId],
    );
    await db.query(`UPDATE nzi_console.clients SET logo_asset_id=$3,updated_at=now() WHERE organisation_id=$1 AND client_id=$2`, [context.organisationId, input.clientId, assetId]);
    return {
      data: { clientId: input.clientId, assetId, byteSize: bytes.length, sha256 },
      before: { logoAssetId: prior.rows[0]?.logo_asset_id ?? null },
      entityType: "client", entityId: input.clientId, topic: "client.logo.set",
    };
  });
}

/** Clears the pointer; the asset row stays (append-only) for the audit trail. */
export function removeClientLogo(pool: PoolLike, input: CommandInputMap["client.logo.remove"], context: CommandContext): Promise<StoredOutcome<ClientLogoResult>> {
  return runPostgresCommand(pool, "client.logo.remove", input, context, async (db) => {
    const prior = await db.query<{ logo_asset_id: string | null }>(`SELECT logo_asset_id FROM nzi_console.clients WHERE organisation_id=$1 AND client_id=$2 FOR UPDATE`, [context.organisationId, input.clientId]);
    await db.query(`UPDATE nzi_console.clients SET logo_asset_id=NULL,updated_at=now() WHERE organisation_id=$1 AND client_id=$2 AND logo_asset_id IS NOT NULL`, [context.organisationId, input.clientId]);
    return {
      data: { clientId: input.clientId, assetId: null },
      before: { logoAssetId: prior.rows[0]?.logo_asset_id ?? null },
      entityType: "client", entityId: input.clientId, topic: "client.logo.removed",
    };
  });
}

export type ClientLogoAsset = { assetId: string; contentType: ClientLogoContentType; sha256: string; content: Buffer };

/** The client's current logo, or null (the monogram is shown instead). Read under the caller's tenant. */
export async function getClientLogo(db: Queryable, clientId: string): Promise<ClientLogoAsset | null> {
  const { rows } = await db.query<{ asset_id: string; content_type: ClientLogoContentType; sha256: string; content: Buffer }>(
    `SELECT a.asset_id,a.content_type,a.sha256,a.content FROM nzi_console.clients c
     JOIN nzi_console.client_logo_assets a ON (a.organisation_id,a.asset_id,a.client_id)=(c.organisation_id,c.logo_asset_id,c.client_id)
     WHERE c.client_id=$1`,
    [clientId],
  );
  const row = rows[0];
  return row ? { assetId: row.asset_id, contentType: row.content_type, sha256: row.sha256, content: row.content } : null;
}

/** One logo asset by id — a report's frozen logo. `clientId` restricts it to that client (the portal). */
export async function getLogoAsset(db: Queryable, assetId: string, options: { clientId?: string } = {}): Promise<ClientLogoAsset | null> {
  const { rows } = await db.query<{ asset_id: string; content_type: ClientLogoContentType; sha256: string; content: Buffer }>(
    `SELECT asset_id,content_type,sha256,content FROM nzi_console.client_logo_assets WHERE asset_id=$1 AND ($2::text IS NULL OR client_id=$2)`,
    [assetId, options.clientId ?? null],
  );
  const row = rows[0];
  return row ? { assetId: row.asset_id, contentType: row.content_type, sha256: row.sha256, content: row.content } : null;
}

/**
 * Serves a logo so it can never act as a document in our origin: nosniff, and a CSP
 * sandbox that forbids script even if an SVG is opened directly.
 */
export function logoResponse(asset: ClientLogoAsset | null, ifNoneMatch: string | null): Response {
  if (!asset) return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  const etag = `"${asset.sha256}"`;
  const headers = { "Content-Type": asset.contentType, "Cache-Control": "private, max-age=300", ETag: etag, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" };
  if (ifNoneMatch === etag) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(asset.content), { status: 200, headers });
}

/** The name and logo a client-facing surface brands itself with (the portal header). */
export async function getClientBrand(db: Queryable, clientId: string): Promise<{ name: string; logoAssetId: string | null } | null> {
  const { rows } = await db.query<{ name: string; logo_asset_id: string | null }>(`SELECT name,logo_asset_id FROM nzi_console.clients WHERE client_id=$1`, [clientId]);
  return rows[0] ? { name: rows[0].name, logoAssetId: rows[0].logo_asset_id ?? null } : null;
}
