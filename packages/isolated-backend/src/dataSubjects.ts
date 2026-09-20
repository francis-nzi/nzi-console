import { randomUUID } from "node:crypto";
import {
  planSubjectLinks, reviewFingerprint,
  type LinkableRow, type ReviewReason, type SourceRef, type SubjectSource, type SupersededEmail,
} from "@nzi/contracts";
import type { Queryable } from "./postgres";

/**
 * Building and curating the subject registry (NZC-116).
 *
 * The rules live in `@nzi/contracts/dataSubjects` and are pure; this reads the rows they judge and
 * writes what they decide. Two properties matter more than anything else here:
 *
 * **Nothing personal is stored.** The registry holds identifiers; links and reviews hold pointers.
 * The only place a name or an address appears is in the `SELECT` below, in memory, for as long as
 * it takes to compare two of them. The machinery that erases personal data must not accumulate any,
 * or it becomes the worst thing on the inventory.
 *
 * **Re-running changes nothing.** The linker proposes; a row already linked is left alone, and a
 * question already asked — or already answered — is not asked again. That is what makes it safe to
 * run on a schedule, and it is enforced by the fingerprint rather than by remembering to check.
 */

/** Where each source keeps the two fields the linker may look at. */
const SOURCE_COLUMNS: Record<SubjectSource, { id: string; email: string; name: string }> = {
  trainees: { id: "trainee_id", email: "personal_email", name: "full_name" },
  client_contacts: { id: "contact_id", email: "email", name: "full_name" },
  portal_users: { id: "portal_user_id", email: "email_normalized", name: "display_name" },
  memberships: { id: "user_id", email: "email", name: "display_name" },
};

/** Every person-row in one organisation, as pointers plus the two comparable fields. */
export async function readLinkableRows(db: Queryable, organisationId: string): Promise<LinkableRow[]> {
  const rows: LinkableRow[] = [];
  for (const [source, columns] of Object.entries(SOURCE_COLUMNS) as Array<[SubjectSource, typeof SOURCE_COLUMNS[SubjectSource]]>) {
    const result = await db.query<{ source_id: string; email: string | null; name: string | null }>(
      `SELECT ${columns.id}::text AS source_id, ${columns.email} AS email, ${columns.name} AS name
         FROM nzi_console.${source} WHERE organisation_id=$1`, [organisationId]);
    for (const row of result.rows) {
      rows.push({ sourceTable: source, sourceId: row.source_id, email: row.email, name: row.name });
    }
  }
  return rows;
}

/** Addresses trainees used to have, for the history-match question. */
export async function readSupersededEmails(db: Queryable, organisationId: string): Promise<SupersededEmail[]> {
  const { rows } = await db.query<{ trainee_id: string; current_email: string; new_email: string }>(
    `SELECT trainee_id, current_email, new_email FROM nzi_console.trainee_email_changes
      WHERE organisation_id=$1`, [organisationId]);
  return rows.map((row) => ({
    sourceTable: "trainees" as const, sourceId: row.trainee_id,
    oldEmail: row.current_email, newEmail: row.new_email,
  }));
}

export type LinkerOutcome = {
  subjectsCreated: number;
  rowsLinked: number;
  reviewsRaised: number;
  /** Questions the plan produced that were already asked or already answered. */
  reviewsSkipped: number;
};

/**
 * Bring the registry up to date with the rows as they are now.
 *
 * Additive by construction: it never unlinks a row and never reopens a decided question. A row that
 * has a subject keeps it, even if the rules would now group it differently — because changing that
 * is a judgement about a person's identity, and this function does not make those.
 */
export async function runSubjectLinker(db: Queryable, organisationId: string, actorId: string): Promise<LinkerOutcome> {
  const [rows, superseded] = await Promise.all([
    readLinkableRows(db, organisationId),
    readSupersededEmails(db, organisationId),
  ]);
  const plan = planSubjectLinks(rows, superseded);

  const linked = await db.query<{ source_table: string; source_id: string }>(
    `SELECT source_table, source_id FROM nzi_console.data_subject_links WHERE organisation_id=$1`, [organisationId]);
  const alreadyLinked = new Set(linked.rows.map((row) => `${row.source_table}:${row.source_id}`));

  const outcome: LinkerOutcome = { subjectsCreated: 0, rowsLinked: 0, reviewsRaised: 0, reviewsSkipped: 0 };

  for (const link of plan.links) {
    const fresh = link.members.filter((member) => !alreadyLinked.has(`${member.sourceTable}:${member.sourceId}`));
    if (fresh.length === 0) continue;

    // If part of the group is already known, join that subject rather than minting a rival one.
    const existing = await subjectFor(db, organisationId, link.members);
    const subjectId = existing ?? randomUUID();
    if (!existing) {
      await db.query(
        `INSERT INTO nzi_console.data_subjects (organisation_id,subject_id,created_by) VALUES ($1,$2,$3)`,
        [organisationId, subjectId, actorId]);
      outcome.subjectsCreated += 1;
    }
    for (const member of fresh) {
      await db.query(
        `INSERT INTO nzi_console.data_subject_links (organisation_id,subject_id,source_table,source_id,link_method,linked_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (organisation_id,source_table,source_id) DO NOTHING`,
        [organisationId, subjectId, member.sourceTable, member.sourceId, link.method, actorId]);
      outcome.rowsLinked += 1;
    }
  }

  for (const review of plan.reviews) {
    const raised = await raiseReview(db, organisationId, review.reason, review.members);
    if (raised) outcome.reviewsRaised += 1;
    else outcome.reviewsSkipped += 1;
  }

  return outcome;
}

/** The subject any of these rows already belongs to, if one of them does. */
async function subjectFor(db: Queryable, organisationId: string, members: readonly SourceRef[]): Promise<string | null> {
  for (const member of members) {
    const { rows } = await db.query<{ subject_id: string }>(
      `SELECT subject_id FROM nzi_console.data_subject_links
        WHERE organisation_id=$1 AND source_table=$2 AND source_id=$3`,
      [organisationId, member.sourceTable, member.sourceId]);
    if (rows[0]) return rows[0].subject_id;
  }
  return null;
}

/**
 * Ask a question once.
 *
 * The fingerprint is the question's identity — its reason and its members — so an open question is
 * recognised on the next run, and a decided one stays decided. Returns whether anything was raised.
 */
async function raiseReview(
  db: Queryable, organisationId: string, reason: ReviewReason, members: readonly SourceRef[],
): Promise<boolean> {
  const fingerprint = reviewFingerprint(reason, members);
  const { rows } = await db.query<{ review_id: string }>(
    `SELECT r.review_id
       FROM nzi_console.data_subject_reviews r
      WHERE r.organisation_id=$1 AND r.reason=$2
        AND (SELECT string_agg(m.source_table||':'||m.source_id, ',' ORDER BY m.source_table||':'||m.source_id)
               FROM nzi_console.data_subject_review_members m
              WHERE (m.organisation_id,m.review_id)=(r.organisation_id,r.review_id)) = $3`,
    [organisationId, reason, fingerprint.slice(reason.length + 1)]);
  if (rows[0]) return false;

  const reviewId = randomUUID();
  await db.query(
    `INSERT INTO nzi_console.data_subject_reviews (organisation_id,review_id,reason) VALUES ($1,$2,$3)`,
    [organisationId, reviewId, reason]);
  for (const member of members) {
    await db.query(
      `INSERT INTO nzi_console.data_subject_review_members (organisation_id,review_id,source_table,source_id)
       VALUES ($1,$2,$3,$4)`, [organisationId, reviewId, member.sourceTable, member.sourceId]);
  }
  return true;
}

export type OpenReview = {
  organisationId: string;
  reviewId: string;
  reason: ReviewReason;
  memberCount: number;
  createdAt: string;
};

/**
 * Every open question, across organisations.
 *
 * Goes through `open_subject_reviews()` — a SECURITY DEFINER function — because a person is not
 * confined to one tenant and RLS cannot express that. The function's return list is the contract:
 * pointers, reasons and counts, never a name. A reviewer who needs to see the person reads the
 * source row through the ordinary tenant-scoped path, where the usual rules and audit apply.
 *
 * The capability check is the caller's, and `subject.review` is held by Admin alone.
 */
export async function listOpenSubjectReviews(db: Queryable): Promise<OpenReview[]> {
  const { rows } = await db.query<{
    organisation_id: string; review_id: string; reason: ReviewReason;
    member_count: number; created_at: Date | string;
  }>(`SELECT * FROM nzi_console.open_subject_reviews()`);
  return rows.map((row) => ({
    organisationId: row.organisation_id,
    reviewId: row.review_id,
    reason: row.reason,
    memberCount: row.member_count,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
}
