// Reporting client-review loop S1 (RULING-reporting-client-review-state-model; BRIEF-EPIC-reporting-client-review-loop) — the four
// transitions that take a validated report version through the client's review to its final approval, and back round again:
//
//   report.sendToClientReview   validated        → in_client_review     (staff, report.publish)
//   report.clientApprove        in_client_review → client_approved      (a granted portal user; D1: one is enough)
//   report.finalApprove         client_approved  → published (Final)    (staff, report.publish; freezes the composition, D6)
//   report.reopen               client_approved | published → a NEW round in_client_review (staff; D2: the client asks by message)
//
// Every transition is pinned to the version the caller saw (`expectedVersion`) and to the status it expects, so a stale screen is
// refused rather than acted on — and the client can only approve the content that was on their screen. A status is checked against
// the contract's allow-list (`reportLifecycle.ts`); the database's CHECKs and unique indexes (0214) are the second line.
import { randomUUID } from "node:crypto";
import { clientMayEdit, CLIENT_EDITABLE_STATUSES, reportNarrativeBodyIssues, type CommandContext, type CommandInputMap, type ReportNarrativeElement } from "@nzi/contracts";
import { ScopeConflictError, VersionConflictError, isUniqueViolation } from "./errors";
import type { PoolLike, Queryable } from "./postgres";
import { appendReportVersionEdit } from "./reportVersionEdits";
import { CommandValidationError, issueReportVersion, requireReleasableSnapshot, runPostgresCommand, type StoredOutcome } from "./postgresCommands";

type LockedVersion = { job_id: string; status: string; version: number; manifest_version: number; reviewed_snapshot_id: string; scope_key: string; revision: number };

const refuse = (field: string, code: string, message: string) => new CommandValidationError([{ field, code, message }]);

/** The version row, locked for this transaction. Not found is the same refusal whoever asks. */
async function lockVersion(db: Queryable, organisationId: string, reportVersionId: string): Promise<LockedVersion> {
  const row = (await db.query<LockedVersion>(
    `SELECT job_id, status, version, manifest_version, reviewed_snapshot_id, scope_key, revision FROM nzi_console.report_versions
      WHERE organisation_id = $1 AND report_version_id = $2 FOR UPDATE`, [organisationId, reportVersionId])).rows[0];
  if (!row) throw refuse("reportVersionId", "NOT_FOUND", "Report version was not found.");
  return row;
}

/** The version the caller saw is the version acted on: two actors racing on one round must not both proceed. */
const requireSeenVersion = (row: LockedVersion, expectedVersion: number) => { if (row.version !== expectedVersion) throw new VersionConflictError(expectedVersion, row.version); };

/** Portal users who could receive a round: active, with a live grant on the job. A round with none would be sent to nobody. */
async function grantedPortalUsers(db: Queryable, organisationId: string, jobId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(DISTINCT g.portal_user_id)::text AS n FROM nzi_console.portal_access_grants g
       JOIN nzi_console.portal_users u ON (u.organisation_id, u.portal_user_id, u.client_id) = (g.organisation_id, g.portal_user_id, g.client_id)
      WHERE g.organisation_id = $1 AND g.job_id = $2 AND g.revoked_at IS NULL AND u.status = 'active'`, [organisationId, jobId]);
  return Number(rows[0]?.n ?? 0);
}

const NO_PORTAL_ACCESS = () => refuse("reportVersionId", "NO_PORTAL_ACCESS", "No portal user has access to this job, so there is no one to review the report. Grant portal access first.");
const openRoundConflict = () => new ScopeConflictError("Another round of this report is already open with the client at this scope — open that one, or reload.");

/** validated → in_client_review. */
export async function sendReportToClientReview(pool: PoolLike, input: CommandInputMap["report.sendToClientReview"], context: CommandContext) {
  return runPostgresCommand(pool, "report.sendToClientReview", input, context, async (db) => {
    const report = await lockVersion(db, context.organisationId, input.reportVersionId);
    requireSeenVersion(report, input.expectedVersion);
    if (report.status !== "validated") throw refuse("expectedStatus", "PRECONDITION", "Only a validated report can be sent to the client for review.");
    // Still released from an approved snapshot (the same check validate and publish make); the preparer's separation is
    // enforced where the report is issued, at final approval.
    const snapshot = (await db.query<{ approved_by: string | null }>(
      `SELECT approved_by FROM nzi_console.reviewed_crp_snapshots WHERE organisation_id = $1 AND snapshot_id = $2`, [context.organisationId, report.reviewed_snapshot_id])).rows[0];
    if (!snapshot?.approved_by) throw refuse("reviewedSnapshotId", "SNAPSHOT_NOT_APPROVED", "The reviewed snapshot must be approved before a report is sent to the client.");
    const recipients = await grantedPortalUsers(db, context.organisationId, report.job_id);
    if (recipients === 0) throw NO_PORTAL_ACCESS();
    let updated;
    try {
      updated = await db.query<{ version: number; sent_to_review_at: Date | string }>(
        `UPDATE nzi_console.report_versions SET status = 'in_client_review', sent_to_review_at = now(), sent_to_review_by = $3, version = version + 1
          WHERE organisation_id = $1 AND report_version_id = $2 AND status = 'validated' AND version = $4 RETURNING version, sent_to_review_at`,
        [context.organisationId, input.reportVersionId, context.actorId, input.expectedVersion]);
    } catch (error) {
      if (isUniqueViolation(error)) throw openRoundConflict();
      throw error;
    }
    if (!updated.rows[0]) throw new VersionConflictError(input.expectedVersion, report.version);
    const sentAt = updated.rows[0].sent_to_review_at instanceof Date ? updated.rows[0].sent_to_review_at.toISOString() : String(updated.rows[0].sent_to_review_at);
    return {
      data: { reportVersionId: input.reportVersionId, jobId: report.job_id, status: "in_client_review" as const, version: updated.rows[0].version, revision: report.revision, sentAt, recipients },
      before: { status: "validated", version: report.version },
      entityType: "report_version", entityId: input.reportVersionId, topic: "report.sentToClientReview",
    };
  });
}

/**
 * in_client_review → client_approved, by one granted portal user (D1). The approval joins `portal_report_approvals` — the record
 * the CRM's inbox already reads — and the version's client side locks. Authorised before this runs: the user is active, with a live
 * grant on the report's job (`authorizePortalReportCommand`).
 */
export async function approveReportAsClient(pool: PoolLike, input: CommandInputMap["report.clientApprove"], context: CommandContext) {
  return runPostgresCommand(pool, "report.clientApprove", input, context, async (db) => {
    const report = await lockVersion(db, context.organisationId, input.reportVersionId);
    requireSeenVersion(report, input.expectedVersion);
    if (report.status !== "in_client_review") throw refuse("reportVersionId", "PRECONDITION", report.status === "client_approved"
      ? "This report has already been approved." : "This report is not open for your review.");
    const clientId = context.portal!.clientId;
    await db.query(
      `INSERT INTO nzi_console.portal_report_approvals (organisation_id, approval_id, report_version_id, job_id, portal_user_id, client_id)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (organisation_id, report_version_id, portal_user_id) DO NOTHING`,
      [context.organisationId, randomUUID(), input.reportVersionId, report.job_id, context.actorId, clientId]);
    const updated = await db.query<{ version: number; client_approved_at: Date | string }>(
      `UPDATE nzi_console.report_versions SET status = 'client_approved', client_approved_at = now(), client_approved_by = $3, version = version + 1
        WHERE organisation_id = $1 AND report_version_id = $2 AND status = 'in_client_review' AND version = $4 RETURNING version, client_approved_at`,
      [context.organisationId, input.reportVersionId, context.actorId, input.expectedVersion]);
    if (!updated.rows[0]) throw new VersionConflictError(input.expectedVersion, report.version);
    const approvedAt = updated.rows[0].client_approved_at instanceof Date ? updated.rows[0].client_approved_at.toISOString() : String(updated.rows[0].client_approved_at);
    return {
      data: { reportVersionId: input.reportVersionId, jobId: report.job_id, clientId, status: "client_approved" as const, version: updated.rows[0].version, approvedAt },
      before: { status: "in_client_review", version: report.version },
      entityType: "report_version", entityId: input.reportVersionId, topic: "report.clientApproved",
    };
  });
}

/**
 * client_approved → published, marked final (D5): the CRM's final approval. Review-then-approve (ruled) — a content change needs
 * `report.reopen` first. The snapshot gate is publish's own, unchanged here (S2 attaches the organisation setting to this command).
 * The composition is composed live until now and frozen here, exactly as `report.publish` freezes it (D6).
 */
export async function finalApproveReport(pool: PoolLike, input: CommandInputMap["report.finalApprove"], context: CommandContext) {
  return runPostgresCommand(pool, "report.finalApprove", input, context, async (db, access) => {
    const report = await lockVersion(db, context.organisationId, input.reportVersionId);
    requireSeenVersion(report, input.expectedVersion);
    if (report.status !== "client_approved") throw refuse("expectedStatus", "PRECONDITION", "Only a report the client has approved can be given its final approval.");
    if (report.manifest_version !== input.manifestVersion || report.reviewed_snapshot_id !== input.reviewedSnapshotId) {
      throw refuse("reportVersionId", "EVIDENCE_MISMATCH", "The report version does not match the reviewed snapshot and manifest supplied.");
    }
    const source = (await db.query<{ created_by: string; approved_by: string | null }>(
      `SELECT created_by, approved_by FROM nzi_console.reviewed_crp_snapshots WHERE organisation_id = $1 AND snapshot_id = $2`, [context.organisationId, report.reviewed_snapshot_id])).rows[0];
    if (!source) throw refuse("reviewedSnapshotId", "NOT_FOUND", "Reviewed snapshot was not found.");
    const releasedByPreparer = await requireReleasableSnapshot(context, source, access, db);
    const { publishedAt, frozen } = await issueReportVersion(db, context, { reportVersionId: input.reportVersionId, jobId: report.job_id, scopeKey: report.scope_key }, "client_approved");
    return {
      data: { reportVersionId: input.reportVersionId, jobId: report.job_id, reviewedSnapshotId: report.reviewed_snapshot_id, manifestVersion: report.manifest_version, status: "published" as const, final: true as const,
        finalApprovedAt: publishedAt, publishedAt, revision: report.revision, compositionId: frozen.compositionId, compositionHash: frozen.dataHash, ...(releasedByPreparer ? { releasedByPreparer: true as const } : {}) },
      before: { status: "client_approved", version: report.version },
      entityType: "report_version", entityId: input.reportVersionId, topic: "report.finalApproved",
    };
  });
}

/**
 * Open a new round (D2: the client asks by message; the CRM executes). Always a NEW row — revision + 1, supersedes_report_version_id
 * pointing back, plan, narrative, signee and issuer copied so the words carry forward — and the earlier round's content is never
 * touched. From `published` the earlier version stays live (the client is never left with nothing) and is superseded when the new
 * round is finally approved; from `client_approved` it is superseded now, since it was itself still open. Needs a reason.
 */
export async function reopenReport(pool: PoolLike, input: CommandInputMap["report.reopen"], context: CommandContext) {
  return runPostgresCommand(pool, "report.reopen", input, context, async (db) => {
    const report = await lockVersion(db, context.organisationId, input.reportVersionId);
    requireSeenVersion(report, input.expectedVersion);
    if (report.status !== input.expectedStatus) throw refuse("expectedStatus", "PRECONDITION", `This report is ${report.status.replace(/_/g, " ")}, not ${input.expectedStatus.replace(/_/g, " ")} — reload to see where it stands.`);
    if (report.status !== "client_approved" && report.status !== "published") {
      throw refuse("reportVersionId", "PRECONDITION", report.status === "in_client_review" ? "This report is already open for the client's review." : "Only a client-approved or published report can be reopened.");
    }
    if (await grantedPortalUsers(db, context.organisationId, report.job_id) === 0) throw NO_PORTAL_ACCESS();
    if (report.status === "client_approved") {
      await db.query(`UPDATE nzi_console.report_versions SET status = 'superseded', version = version + 1 WHERE organisation_id = $1 AND report_version_id = $2 AND status = 'client_approved'`,
        [context.organisationId, input.reportVersionId]);
    }
    const reportVersionId = randomUUID();
    try {
      await db.query(
        `INSERT INTO nzi_console.report_versions (organisation_id, report_version_id, job_id, status, manifest_version, reviewed_snapshot_id, data_hash, validated_by,
            signee_contact_id, signee_name, signee_job_title, signee_name_sealed, signee_job_title_sealed, client_logo_asset_id,
            issuer_display_name, issuer_short_name, issuer_footer, issuer_logo_asset_id, scope_kind, scope_site_ids,
            section_plan, section_plan_origin, client_issuer_line, narrative, sent_to_review_at, sent_to_review_by, revision, supersedes_report_version_id)
         SELECT organisation_id, $3, job_id, 'in_client_review', manifest_version, reviewed_snapshot_id, data_hash, validated_by,
            signee_contact_id, signee_name, signee_job_title, signee_name_sealed, signee_job_title_sealed, client_logo_asset_id,
            issuer_display_name, issuer_short_name, issuer_footer, issuer_logo_asset_id, scope_kind, scope_site_ids,
            section_plan, section_plan_origin, client_issuer_line, narrative, now(), $4, revision + 1, report_version_id
           FROM nzi_console.report_versions WHERE organisation_id = $1 AND report_version_id = $2`,
        [context.organisationId, input.reportVersionId, reportVersionId, context.actorId]);
    } catch (error) {
      if (isUniqueViolation(error)) throw openRoundConflict();
      throw error;
    }
    return {
      data: { reportVersionId, jobId: report.job_id, status: "in_client_review" as const, revision: report.revision + 1, reopenedFromReportVersionId: input.reportVersionId, reopenedFromStatus: report.status,
        earlierRound: report.status === "published" ? "stays-live" as const : "superseded" as const },
      before: { reportVersionId: input.reportVersionId, status: report.status, version: report.version, revision: report.revision },
      entityType: "report_version", entityId: reportVersionId, topic: "report.reopened",
    };
  });
}

/** Why a client cannot edit a round, in the client's words - never the staff's ("reopen it" is theirs to ask, not to do). */
export function clientEditRefusal(status: unknown): string {
  if (status === "client_approved") return "You have approved this report, so it is locked. Message the team if you need to change it.";
  if (status === "published") return "This report has been issued and can no longer be edited. Message the team if you need a change.";
  if (status === "superseded") return "A newer version of this report has replaced this one.";
  return "This report is not open for your edits.";
}

/**
 * Client-review loop S4: the client's "Update" - a batch of narrative edits to a round open for their review. Mirrors the staff
 * amend (lock the version, validate each tokenised body, re-freeze onto `report_versions.narrative`, write the S3 history) as a
 * portal command, with these differences: it is gated by the CLIENT allow-list (`in_client_review` only - `client_approved` locks the
 * client out), it never touches the job's working sections (the client edits THIS round, not the template the next report starts from),
 * and the whole save is one batch and ONE version bump, so an approval afterwards is of exactly what was saved.
 * Figures are not editable: a body is tokenised HTML, a typed figure or money is refused, and only the sections the version already
 * draws (its frozen narrative) can change - charts, tables and figures are not narrative.
 */
export async function updateReportAsClient(pool: PoolLike, input: CommandInputMap["portal.report.update"], context: CommandContext) {
  return runPostgresCommand(pool, "portal.report.update", input, context, async (db) => {
    const report = await lockVersion(db, context.organisationId, input.reportVersionId);
    requireSeenVersion(report, input.expectedVersion);
    if (!clientMayEdit(report.status)) throw refuse("reportVersionId", "PRECONDITION", clientEditRefusal(report.status));
    const frozen = (await db.query<{ narrative: ReportNarrativeElement[] | null }>(
      `SELECT narrative FROM nzi_console.report_versions WHERE organisation_id = $1 AND report_version_id = $2`, [context.organisationId, input.reportVersionId])).rows[0]?.narrative;
    if (!frozen) throw refuse("reportVersionId", "NO_FROZEN_NARRATIVE", "This report has no editable wording.");
    const issues: Array<{ field: string; code: string; message: string }> = [];
    const next = frozen.map((element) => element);
    const changed: Array<{ sectionKey: string; before: string; after: string }> = [];
    for (const edit of input.edits) {
      const index = next.findIndex((element) => element.key === edit.sectionKey);
      if (index < 0) { issues.push({ field: `edits.${edit.sectionKey}`, code: "NOT_EDITABLE", message: "This report does not draw that section as editable wording." }); continue; }
      const bodyHtml = edit.bodyHtml.trim();
      // The same rule the staff amend holds a body to (B2-4): the server never trusts the browser's check.
      for (const issue of reportNarrativeBodyIssues(bodyHtml)) issues.push({ field: `edits.${edit.sectionKey}`, code: issue.code, message: issue.message });
      if (bodyHtml === next[index]!.bodyHtml) continue;
      changed.push({ sectionKey: edit.sectionKey, before: next[index]!.bodyHtml, after: bodyHtml });
      next[index] = { ...next[index]!, bodyHtml, contentSource: "client-edited" };
    }
    if (issues.length) throw new CommandValidationError(issues);
    // Nothing differs from what is frozen: nothing is written, the version does not move, and the client is told so.
    if (changed.length === 0) {
      return { data: { reportVersionId: input.reportVersionId, jobId: report.job_id, version: report.version, changedSections: [] as string[], batchId: null as string | null },
        entityType: "report_version", entityId: input.reportVersionId, topic: "report.clientUpdated" };
    }
    const updated = await db.query<{ version: number }>(
      `UPDATE nzi_console.report_versions SET narrative = $3::jsonb, version = version + 1
        WHERE organisation_id = $1 AND report_version_id = $2 AND status = ANY($5::text[]) AND version = $4 RETURNING version`,
      [context.organisationId, input.reportVersionId, JSON.stringify(next), input.expectedVersion, [...CLIENT_EDITABLE_STATUSES]]);
    if (!updated.rows[0]) throw new VersionConflictError(input.expectedVersion, report.version);
    const batchId = randomUUID();
    for (const edit of changed) {
      await appendReportVersionEdit(db, { organisationId: context.organisationId, reportVersionId: input.reportVersionId, actorId: context.actorId, principal: "portal",
        sectionKey: edit.sectionKey, action: "edit", beforeHtml: edit.before, afterHtml: edit.after, batchId });
    }
    return {
      data: { reportVersionId: input.reportVersionId, jobId: report.job_id, version: updated.rows[0].version, changedSections: changed.map((edit) => edit.sectionKey), batchId },
      before: { version: report.version },
      entityType: "report_version", entityId: input.reportVersionId, topic: "report.clientUpdated",
    };
  });
}

export type ReportReviewOutcome<T extends Record<string, unknown> = Record<string, unknown>> = StoredOutcome<T>;
