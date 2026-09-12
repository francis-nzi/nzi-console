import type { Queryable } from "./postgres";

/**
 * Read-only projections for the client workspace areas that have real records behind
 * them (client workspace v10, phase 2). Each one reads what the client actually has —
 * an area with no table behind it gets no read model here, and says so on screen rather
 * than being given an empty list that reads like "this client has nothing".
 *
 * Read-only and dependency-free, like `clientContactRecords` / `clientTargetRecords`, so
 * the workspace read model can use them without a cycle through the command modules.
 */

const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : String(value);

/** One report version belonging to this client, newest first. */
export type ClientReportReadModel = {
  reportVersionId: string;
  jobId: string;
  jobNumber: string;
  title: string;
  reportingYear: number | null;
  status: "draft" | "validated" | "published" | "superseded";
  manifestVersion: number;
  snapshotId: string;
  createdAt: string;
  publishedAt: string | null;
  /** The client's own review activity on this version. */
  approvalCount: number;
  commentCount: number;
};

export async function listClientReports(db: Queryable, clientId: string): Promise<ClientReportReadModel[]> {
  const { rows } = await db.query<{
    report_version_id: string; job_id: string; job_number: string; title: string; reporting_year: number | null;
    status: ClientReportReadModel["status"]; manifest_version: number; reviewed_snapshot_id: string;
    created_at: Date | string; published_at: Date | string | null; approval_count: string; comment_count: string;
  }>(`SELECT r.report_version_id,r.job_id,j.job_number,j.title,j.reporting_year,r.status,r.manifest_version,r.reviewed_snapshot_id,r.created_at,r.published_at,
        count(DISTINCT a.approval_id)::text AS approval_count,count(DISTINCT m.comment_id)::text AS comment_count
      FROM nzi_console.report_versions r
      JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(r.organisation_id,r.job_id)
      LEFT JOIN nzi_console.portal_report_approvals a ON (a.organisation_id,a.report_version_id)=(r.organisation_id,r.report_version_id)
      LEFT JOIN nzi_console.portal_report_comments m ON (m.organisation_id,m.report_version_id)=(r.organisation_id,r.report_version_id)
      WHERE j.client_id=$1
      GROUP BY r.organisation_id,r.report_version_id,j.organisation_id,j.job_id
      ORDER BY r.created_at DESC,r.report_version_id DESC`, [clientId]);
  return rows.map((row) => ({
    reportVersionId: row.report_version_id, jobId: row.job_id, jobNumber: row.job_number, title: row.title,
    reportingYear: row.reporting_year, status: row.status, manifestVersion: row.manifest_version,
    snapshotId: row.reviewed_snapshot_id, createdAt: iso(row.created_at),
    publishedAt: row.published_at == null ? null : iso(row.published_at),
    approvalCount: Number(row.approval_count), commentCount: Number(row.comment_count),
  }));
}

/**
 * The client's correspondence. Today that is the review thread on a published report —
 * the only channel this platform actually records. It is **not** an email history, and
 * the screen says so rather than implying every conversation with the client is here.
 */
export type ClientMessageReadModel = {
  commentId: string;
  reportVersionId: string;
  jobId: string;
  jobNumber: string;
  parentCommentId: string | null;
  author: string;
  authorPrincipal: "portal" | "staff";
  body: string;
  at: string;
};

export async function listClientMessages(db: Queryable, clientId: string, limit = 100): Promise<ClientMessageReadModel[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 250);
  const { rows } = await db.query<{
    comment_id: string; report_version_id: string; job_id: string; job_number: string; parent_comment_id: string | null;
    author_display_name: string; author_principal: "portal" | "staff"; body: string; created_at: Date | string;
  }>(`SELECT m.comment_id,m.report_version_id,m.job_id,j.job_number,m.parent_comment_id,m.author_display_name,m.author_principal,m.body,m.created_at
      FROM nzi_console.portal_report_comments m
      JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(m.organisation_id,m.job_id)
      WHERE m.client_id=$1
      ORDER BY m.created_at DESC,m.comment_id DESC
      LIMIT $2`, [clientId, safeLimit]);
  return rows.map((row) => ({
    commentId: row.comment_id, reportVersionId: row.report_version_id, jobId: row.job_id, jobNumber: row.job_number,
    parentCommentId: row.parent_comment_id, author: row.author_display_name, authorPrincipal: row.author_principal,
    body: row.body, at: iso(row.created_at),
  }));
}

/**
 * The files this client actually has. There is no general document store yet, so this is
 * deliberately narrow and each entry says where it came from: the logo asset (bytes held
 * here) and the evidence attached to client factors (metadata only — the file itself
 * lives with whatever provider recorded it).
 */
export type ClientFileReadModel = {
  id: string;
  kind: "logo" | "factor-evidence";
  name: string;
  contentType: string | null;
  byteSize: number | null;
  /** Where the bytes are: this platform, or an external provider that holds them. */
  storage: "console" | "external" | "unknown";
  href: string | null;
  context: string;
  at: string;
  by: string | null;
};

export async function listClientFiles(db: Queryable, clientId: string): Promise<ClientFileReadModel[]> {
  const [logos, evidence] = await Promise.all([
    db.query<{ asset_id: string; file_name: string; content_type: string; byte_size: number; uploaded_by: string | null; uploaded_at: Date | string }>(
      `SELECT asset_id,file_name,content_type,byte_size,uploaded_by,uploaded_at FROM nzi_console.client_logo_assets WHERE client_id=$1 ORDER BY uploaded_at DESC`, [clientId]),
    db.query<{ client_factor_id: string; report_label: string; evidence_file_name: string | null; evidence_storage_provider: string | null; evidence_url: string | null; updated_by: string | null; updated_at: Date | string }>(
      `SELECT client_factor_id,report_label,evidence_file_name,evidence_storage_provider,evidence_url,updated_by,updated_at FROM nzi_console.client_factors WHERE client_id=$1 AND evidence_file_name IS NOT NULL ORDER BY updated_at DESC`, [clientId]),
  ]);
  const files: ClientFileReadModel[] = logos.rows.map((row) => ({
    id: row.asset_id, kind: "logo" as const, name: row.file_name, contentType: row.content_type, byteSize: row.byte_size,
    storage: "console" as const, href: `/api/isolated/logo-assets/${encodeURIComponent(row.asset_id)}`,
    context: "Client logo — appears on the portal and published reports", at: iso(row.uploaded_at), by: row.uploaded_by,
  }));
  for (const row of evidence.rows) {
    files.push({
      id: row.client_factor_id, kind: "factor-evidence", name: row.evidence_file_name ?? "Evidence", contentType: null, byteSize: null,
      storage: row.evidence_storage_provider ? "external" : "unknown", href: row.evidence_url,
      context: `Evidence for client factor “${row.report_label}”${row.evidence_storage_provider ? ` · held by ${row.evidence_storage_provider}` : ""}`,
      at: iso(row.updated_at), by: row.updated_by,
    });
  }
  return files.sort((a, b) => b.at.localeCompare(a.at));
}
