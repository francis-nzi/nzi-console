// Client-review loop S3 (0217; BRIEF-reporting-S3-edit-history): the per-report-version content-edit history.
//
// Append-only and keyed by the REPORT VERSION (the job-level `report_section_versions` cannot say what changed in one version).
// It holds content edits only - lifecycle actions (send, approve, final-approve, reopen) stay in `audit_events`. The bodies are the
// narrative's tokenised HTML (figures are token keys, money is refused at write), so no figure is stored here.
import { randomUUID } from "node:crypto";
import type { Queryable } from "./postgres";

export type ReportVersionEditPrincipal = "staff" | "portal";
/** `amend` - the CRM's change; `edit` - the client's (S4); `restore` - a rollback copying an earlier state (S7). */
export type ReportVersionEditAction = "edit" | "amend" | "restore";

export type ReportVersionEditInput = {
  organisationId: string; reportVersionId: string; actorId: string; principal: ReportVersionEditPrincipal;
  sectionKey: string; action: ReportVersionEditAction; beforeHtml: string; afterHtml: string;
  /** Groups the rows of one save. A single-section amend is a batch of one. */
  batchId?: string;
};

/**
 * Append one edit to a version's history, in the CALLER'S transaction - so the change and its history row commit or roll back
 * together. The caller holds the version row's lock, which serialises `seq`; (version, seq) is unique as the backstop.
 */
export async function appendReportVersionEdit(db: Queryable, input: ReportVersionEditInput): Promise<{ editId: string; seq: number; batchId: string }> {
  const editId = randomUUID();
  const batchId = input.batchId ?? randomUUID();
  const { rows: [row] } = await db.query<{ seq: number }>(
    `INSERT INTO nzi_console.report_version_edits (organisation_id, edit_id, report_version_id, seq, actor_id, principal, section_key, action, before_html, after_html, batch_id)
     SELECT $1, $2, $3, coalesce(max(seq), 0) + 1, $4, $5, $6, $7, $8, $9, $10 FROM nzi_console.report_version_edits WHERE organisation_id = $1 AND report_version_id = $3
     RETURNING seq`,
    [input.organisationId, editId, input.reportVersionId, input.actorId, input.principal, input.sectionKey, input.action, input.beforeHtml, input.afterHtml, batchId]);
  return { editId, seq: row!.seq, batchId };
}

export type ReportVersionEdit = {
  editId: string; reportVersionId: string; seq: number; actorId: string; actorName: string | null; principal: ReportVersionEditPrincipal;
  sectionKey: string; action: ReportVersionEditAction; beforeHtml: string; afterHtml: string; batchId: string; at: string;
};

/** A version's edits, oldest first, with who (a name where the actor is known), what, where and when. Run inside the caller's tenant read. */
export async function listReportVersionEdits(db: Queryable, reportVersionId: string): Promise<ReportVersionEdit[]> {
  const { rows } = await db.query<{
    edit_id: string; report_version_id: string; seq: number; actor_id: string; actor_name: string | null; principal: ReportVersionEditPrincipal;
    section_key: string; action: ReportVersionEditAction; before_html: string; after_html: string; batch_id: string; at: Date | string;
  }>(
    `SELECT e.edit_id, e.report_version_id, e.seq, e.actor_id, e.principal, e.section_key, e.action, e.before_html, e.after_html, e.batch_id, e.at,
            CASE e.principal WHEN 'staff' THEN m.display_name ELSE u.display_name END AS actor_name
       FROM nzi_console.report_version_edits e
       LEFT JOIN nzi_console.memberships m ON e.principal = 'staff' AND (m.organisation_id, m.user_id) = (e.organisation_id, e.actor_id)
       LEFT JOIN nzi_console.portal_users u ON e.principal = 'portal' AND (u.organisation_id, u.portal_user_id) = (e.organisation_id, e.actor_id)
      WHERE e.report_version_id = $1
      ORDER BY e.seq`, [reportVersionId]);
  return rows.map((row) => ({
    editId: row.edit_id, reportVersionId: row.report_version_id, seq: row.seq, actorId: row.actor_id, actorName: row.actor_name ?? null, principal: row.principal,
    sectionKey: row.section_key, action: row.action, beforeHtml: row.before_html, afterHtml: row.after_html, batchId: row.batch_id,
    at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
  }));
}
