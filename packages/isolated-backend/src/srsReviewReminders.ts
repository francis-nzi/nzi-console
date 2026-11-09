import { randomUUID } from "node:crypto";
import {
  SRS_REVIEW_TEMPLATE_KEY, srsNextReviewDate, srsReviewReminderState, srsReviewRecipient, srsReviewTiming, srsReviewValues, todayInLondon,
  type CommandContext, type CommandInputMap, type SrsReviewBlock, type SrsReviewCadence, type SrsReviewCrm, type SrsReviewStatus,
} from "@nzi/contracts";
import { staffFirstNameSql } from "./addressName";
import { dateOnlyOrNull } from "./dates";
import { readReminderSettings } from "./dueReminders";
import { EmailValidationError } from "./email";
import { VersionConflictError } from "./errors";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import { sendTemplatedEmail, TemplatedEmailError } from "./templatedEmail";

/**
 * The SRS review loop, Phase A (BRIEF-srs-iterative-review-and-messaging): a completed assessment's review date, and the
 * once-per-date reminder that prompts the CRM to review it — the A3 pipe (dueReminders.ts), reused as it is.
 *
 * - **Set on completion** (`completeSrsAssessment`): annual by default. **Changed by the CRM** here, under srs.manage
 *   (`srs.assessment.review.set`), on the latest completed assessment only. A change moves the date, which is a new marker key,
 *   so the reminder re-arms.
 * - **The scan enqueues; it never sends.** Each owed reminder is rendered by `sendTemplatedEmail` and queued on
 *   `transactional_outbox`; the worker's existing email drain delivers it, in its own transaction (the #515 discipline).
 * - **To the CRM, never the client**: the client's manager, else its owner — staff mail, as a portal message's is.
 * - **Once per assessment per review date**: the marker (`srs_review_reminders`, 0220) is written in the same transaction as the
 *   email. A blocked reminder is counted, surfaced in the SRS area, and not marked — it goes once the CRM is put right.
 * - **Gated** by the Admin reminder switch (A3, R6) and the lead it sets; `off` on the assessment sends nothing.
 * - **Audited by reference**: the template, the recipient's user id, the email's id — never the address.
 *
 * The CRM then reopens or reassesses through the existing commands; nothing here edits an answer.
 */

/** Who the audit trail names for the scan's enqueues: the worker, as a system principal. */
export const SRS_REVIEW_ACTOR = "worker:srs-review-reminders";

const refuse = (field: string, code: string, message: string) => new CommandValidationError([{ field, code, message }]);
const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : String(value);

/** The latest assessment of a client, as the read model and reopen order them. */
const LATEST_ASSESSMENT_SQL = (alias: string) => `(SELECT x.assessment_id FROM nzi_console.srs_assessments x
   WHERE x.organisation_id = ${alias}.organisation_id AND x.client_id = ${alias}.client_id
   ORDER BY coalesce(x.assessed_on, x.started_on) DESC, x.assessment_id DESC LIMIT 1)`;

export type SetSrsReviewResult = { assessmentId: string; version: number; cadence: SrsReviewCadence; nextReviewDate: string | null };

/** The CRM sets when the latest completed assessment is next reviewed: a cadence from its assessed date, a date, or off. */
export function setSrsReviewSchedule(pool: PoolLike, input: CommandInputMap["srs.assessment.review.set"], context: CommandContext): Promise<StoredOutcome<SetSrsReviewResult>> {
  return runPostgresCommand(pool, "srs.assessment.review.set", input, context, async (db) => {
    const row = (await db.query<{ version: number; status: "draft" | "complete"; client_id: string; assessed_on: Date | string | null; review_cadence: SrsReviewCadence | null; next_review_date: Date | string | null; latest: string }>(
      `SELECT a.version, a.status, a.client_id, a.assessed_on, a.review_cadence, a.next_review_date, ${LATEST_ASSESSMENT_SQL("a")} AS latest
         FROM nzi_console.srs_assessments a WHERE a.organisation_id = $1 AND a.assessment_id = $2 FOR UPDATE`,
      [context.organisationId, input.assessmentId])).rows[0];
    if (!row) throw refuse("assessmentId", "NOT_FOUND", "That assessment does not exist.");
    if (row.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, row.version);
    if (row.status !== "complete") throw refuse("assessmentId", "NOT_COMPLETE", "A review date is set once the assessment is complete.");
    if (row.latest !== input.assessmentId) throw refuse("assessmentId", "NOT_LATEST", "Only the latest assessment has a review date; a later one has superseded this.");
    const assessedOn = dateOnlyOrNull(row.assessed_on)!;
    if (input.cadence === "custom" && input.customDate! < todayInLondon()) throw refuse("customDate", "IN_PAST", "Choose a review date from today on.");
    const nextReviewDate = srsNextReviewDate(assessedOn, input.cadence, input.customDate ?? null);
    const before = { cadence: row.review_cadence, nextReviewDate: dateOnlyOrNull(row.next_review_date) };
    if (before.cadence === input.cadence && before.nextReviewDate === nextReviewDate) throw refuse("cadence", "UNCHANGED", "That is the review date already set.");
    const saved = await db.query<{ version: number }>(
      `UPDATE nzi_console.srs_assessments SET review_cadence = $3, next_review_date = $4, updated_at = now(), version = version + 1
        WHERE organisation_id = $1 AND assessment_id = $2 RETURNING version`,
      [context.organisationId, input.assessmentId, input.cadence, nextReviewDate]);
    return {
      data: { assessmentId: input.assessmentId, version: saved.rows[0]!.version, cadence: input.cadence, nextReviewDate },
      entityType: "srs_assessment", entityId: input.assessmentId, topic: "srs.assessment.review_set",
      before,
    };
  });
}

/* ── The scan ────────────────────────────────────────────────────────────────────────────────────────────────────── */

export type SrsReviewScan = {
  /** The Admin master switch as read this tick. Off: nothing was considered. */
  enabled: boolean;
  owed: number;
  enqueued: number;
  blocked: Record<SrsReviewBlock, number>;
  /** Owed and sendable, but the render or the address was refused — never sent half-made; tried again next tick. */
  refused: number;
};

type CandidateRow = {
  assessment_id: string; client_id: string; assessed_on: Date | string; review_cadence: SrsReviewCadence; next_review_date: Date | string; client_name: string;
  crm_user_id: string | null; email: string | null; member_status: string | null; first_name: string | null; display_name: string | null;
};

const crmOf = (row: Pick<CandidateRow, "crm_user_id" | "email" | "member_status" | "first_name" | "display_name">): SrsReviewCrm =>
  row.crm_user_id === null ? null
    : { userId: row.crm_user_id, email: row.email, status: row.member_status ?? "inactive", firstName: row.first_name, displayName: row.display_name };

/**
 * One scan: every client's latest completed assessment with a review date, not yet reminded for that date, checked against
 * its window and its CRM; each one owed and sendable enqueued, marked and audited. Run it in a transaction of its own, as
 * `nzi_console_worker`. Without `consoleOrigin` it refuses outright: a reminder that cannot link to the SRS area is not sent.
 */
export async function scanSrsReviewReminders(db: Queryable, input: { organisationId: string; today: string; consoleOrigin: string | undefined }): Promise<SrsReviewScan> {
  const settings = await readReminderSettings(db, input.organisationId);
  const summary: SrsReviewScan = { enabled: settings.enabled, owed: 0, enqueued: 0, blocked: { "no-crm": 0, "crm-inactive": 0, "no-email": 0 }, refused: 0 };
  if (!settings.enabled) return summary;
  let origin: string;
  try { origin = new URL(input.consoleOrigin ?? "").origin; }
  catch { throw new Error("The console's own address (NZI_ISOLATED_API_URL) is not set, so an SRS review reminder could not link to the console; none was sent."); }

  const { rows } = await db.query<CandidateRow>(
    `SELECT a.assessment_id, a.client_id, a.assessed_on, a.review_cadence, a.next_review_date, c.name AS client_name,
            coalesce(c.client_manager_user_id, c.owner_user_id) AS crm_user_id,
            m.email, m.status AS member_status, ${staffFirstNameSql("m")} AS first_name, m.display_name
       FROM nzi_console.srs_assessments a
       JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (a.organisation_id, a.client_id)
       LEFT JOIN nzi_console.memberships m ON (m.organisation_id, m.user_id) = (a.organisation_id, coalesce(c.client_manager_user_id, c.owner_user_id))
      WHERE a.organisation_id = $1 AND c.status = 'active' AND a.status = 'complete'
        AND a.review_cadence <> 'off' AND a.next_review_date IS NOT NULL AND a.next_review_date - $3::int <= $2::date
        AND a.assessment_id = ${LATEST_ASSESSMENT_SQL("a")}
        AND NOT EXISTS (SELECT 1 FROM nzi_console.srs_review_reminders r
                         WHERE (r.organisation_id, r.assessment_id, r.review_date) = (a.organisation_id, a.assessment_id, a.next_review_date))
      ORDER BY a.next_review_date, a.assessment_id`,
    [input.organisationId, input.today, settings.defaultLeadDays]);

  for (const row of rows) {
    const timing = srsReviewTiming({ status: "complete", reviewCadence: row.review_cadence, nextReviewDate: dateOnlyOrNull(row.next_review_date), latest: true }, input.today, settings.defaultLeadDays);
    if (timing.kind !== "owed") continue;
    summary.owed += 1;
    const recipient = srsReviewRecipient(crmOf(row));
    if (!recipient.ok) { summary.blocked[recipient.why] += 1; continue; }

    const reminderId = randomUUID();
    let emailMessageId: string;
    try {
      ({ emailMessageId } = await sendTemplatedEmail(db, input.organisationId, {
        templateCode: SRS_REVIEW_TEMPLATE_KEY, to: recipient.email, consoleOrigin: origin,
        vars: srsReviewValues({ firstName: recipient.firstName, clientName: row.client_name, assessedOn: dateOnlyOrNull(row.assessed_on)!, reviewDate: timing.reviewDate,
          srsLink: `${origin}/clients/${encodeURIComponent(row.client_id)}?area=srs` }),
        correlationId: reminderId,
        idempotencyKey: `${SRS_REVIEW_TEMPLATE_KEY}:${row.assessment_id}:${timing.reviewDate}`,
      }));
    } catch (error) {
      if (error instanceof TemplatedEmailError || error instanceof EmailValidationError) { summary.refused += 1; continue; }
      throw error;
    }
    const marked = await db.query<{ reminder_id: string }>(
      `INSERT INTO nzi_console.srs_review_reminders
         (organisation_id, reminder_id, assessment_id, client_id, review_date, lead_days, recipient_user_id, template_code, email_message_id)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9)
       ON CONFLICT (organisation_id, assessment_id, review_date) DO NOTHING
       RETURNING reminder_id`,
      [input.organisationId, reminderId, row.assessment_id, row.client_id, timing.reviewDate, timing.leadDays, recipient.userId, SRS_REVIEW_TEMPLATE_KEY, emailMessageId]);
    if (marked.rows.length === 0) continue;
    await db.query(
      `INSERT INTO nzi_console.audit_events
         (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, after_json, client_id)
       VALUES ($1, $2, $3, 'system', 'srs_review_reminder_enqueued', 'srs_assessment', $4, $5, $6::jsonb, $7)`,
      [input.organisationId, randomUUID(), SRS_REVIEW_ACTOR, row.assessment_id, reminderId,
        JSON.stringify({ templateCode: SRS_REVIEW_TEMPLATE_KEY, recipientUserId: recipient.userId, emailMessageId, reviewDate: timing.reviewDate, leadDays: timing.leadDays }),
        row.client_id]);
    summary.enqueued += 1;
  }
  return summary;
}

/* ── What the CRM sees ───────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The client's review schedule and its reminder, for the SRS area: the latest assessment's, when it is complete. Null when the
 * client has no completed latest assessment (none yet, or one in progress). Read in the console's tenant transaction.
 */
export async function readSrsReviewStatus(db: Queryable, input: { clientId: string; today: string }): Promise<SrsReviewStatus | null> {
  const row = (await db.query<{ assessment_id: string; status: "draft" | "complete"; assessed_on: Date | string | null; review_cadence: SrsReviewCadence | null; next_review_date: Date | string | null; version: number;
    crm_user_id: string | null; email: string | null; member_status: string | null; first_name: string | null; display_name: string | null }>(
    `SELECT a.assessment_id, a.status, a.assessed_on, a.review_cadence, a.next_review_date, a.version,
            coalesce(c.client_manager_user_id, c.owner_user_id) AS crm_user_id, m.email, m.status AS member_status, ${staffFirstNameSql("m")} AS first_name, m.display_name
       FROM nzi_console.srs_assessments a
       JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (a.organisation_id, a.client_id)
       LEFT JOIN nzi_console.memberships m ON (m.organisation_id, m.user_id) = (a.organisation_id, coalesce(c.client_manager_user_id, c.owner_user_id))
      WHERE a.client_id = $1 AND a.assessment_id = ${LATEST_ASSESSMENT_SQL("a")}`, [input.clientId])).rows[0];
  if (!row || row.status !== "complete" || row.review_cadence === null) return null;
  const settings = await readReminderSettings(db);
  const nextReviewDate = dateOnlyOrNull(row.next_review_date);
  const timing = srsReviewTiming({ status: row.status, reviewCadence: row.review_cadence, nextReviewDate, latest: true }, input.today, settings.defaultLeadDays);
  const marker = nextReviewDate === null ? undefined : (await db.query<{ enqueued_at: Date | string }>(
    `SELECT enqueued_at FROM nzi_console.srs_review_reminders WHERE assessment_id = $1 AND review_date = $2::date`, [row.assessment_id, nextReviewDate])).rows[0];
  return {
    assessmentId: row.assessment_id, assessedOn: dateOnlyOrNull(row.assessed_on)!, cadence: row.review_cadence, nextReviewDate, version: row.version,
    reminder: srsReviewReminderState({ enabled: settings.enabled, timing, sentForReviewDate: marker ? { enqueuedAt: iso(marker.enqueued_at) } : null, crm: crmOf(row) }),
  };
}
