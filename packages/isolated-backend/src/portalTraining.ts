import type { Queryable } from "./postgres";
import { trainingPlaceGroups, type TrainingPlaceGroup } from "@nzi/contracts";

/**
 * Client portal · training — READ-ONLY, and deliberately narrow.
 *
 * Two rules shape everything here.
 *
 * **The client sees its own slice, never a person's history.** A trainee is person-centric:
 * the same individual may have trained with a previous employer, and that is theirs, not
 * their current employer's. So every register row is filtered on the booking's employer
 * being the session's own client — which is also why the employer is frozen onto the
 * booking rather than read back from the person.
 *
 * **Nothing is recomputed.** The register comes from the reviewed run snapshot, the same
 * frozen payload the staff module wrote and the family report reads. A run that has not
 * been reviewed does not appear: the honest answer is that it is not yet confirmed, not a
 * provisional number the client might quote back.
 */

export type PortalTrainingRecord = {
  bookingId: string;
  personName: string;
  courseLabel: string;
  /** The run's last session, which is what "completed" means to a client. */
  completedOn: string | null;
  attendancePct: number;
  /** What the certificate actually is, in the client's terms. */
  certificate:
    | { state: "issued"; verifyCode: string; certificateNumber: string; validUntil: string | null }
    | { state: "pending"; reason: string }
    | { state: "not-earned"; reason: string };
};

export type PortalTrainingSkillCell = "current" | "refresher-due" | "none";

export type PortalTrainingReadModel = {
  clientName: string | null;
  /** The places the client holds, counted by the same arithmetic the staff register uses. */
  places: TrainingPlaceGroup[];
  records: PortalTrainingRecord[];
  /** The skills grid: people down, courses across. Built only from issued certificates. */
  skills: { people: string[]; courses: string[]; cells: Record<string, Record<string, PortalTrainingSkillCell>> };
  /** The date every expiry and validity on this page was judged against. */
  asAt: string;
};

type SnapshotPayload = {
  courseRunId: string;
  product: { id: string; name: string; minAttendancePct: number } | null;
  sessions: Array<{ id: string; date: string | null; status: string }>;
  register: Array<{
    bookingId: string; traineeId: string | null; personName: string;
    employerClientId: string | null; attendancePct: number;
    consentStatus: string; attendanceStatus: string;
    certificate: "eligible" | "held" | "not-eligible";
  }>;
  certificates: Array<{ bookingId: string; certificateNumber: string; verifyCode: string }>;
};

const dateOnly = (value: Date | string | null) => value === null ? null : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

/** `months` on from a date, clamped to the end of the month so 31 Jan + 1 month is 28/29 Feb. */
function addMonths(day: string, months: number): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date, lastDay));
  return target.toISOString().slice(0, 10);
}

export async function getPortalClientTraining(
  db: Queryable,
  input: { portalUserId: string; clientId: string; asAt: string },
): Promise<PortalTrainingReadModel> {
  const [clientRows, entitlementRows, snapshotRows, productRows] = await Promise.all([
    db.query<{ name: string }>(`SELECT name FROM nzi_console.clients WHERE client_id=$1`, [input.clientId]),
    // The client's own places. These belong to the client, not to a job grant: a place is
    // something they paid for, and hiding it behind a report grant would hide money they
    // have on the table.
    db.query<{ entitlement_id: string; source_job_id: string; source_job_number: string; status: string; expires_at: Date | string | null; default_from_job_end: boolean; course_label: string | null }>(
      `SELECT e.entitlement_id, e.source_job_id, e.source_job_number, e.status, e.expires_at, e.default_from_job_end,
              p.product_name AS course_label
       FROM nzi_console.training_entitlements e
       LEFT JOIN nzi_console.training_course_runs r ON (r.organisation_id,r.course_run_id)=(e.organisation_id,e.allocated_course_run_id)
       LEFT JOIN nzi_console.training_products p ON (p.organisation_id,p.training_product_id)=(r.organisation_id,r.training_product_id)
       WHERE e.source_client_id=$1 ORDER BY e.source_job_number, e.entitlement_id`,
      [input.clientId]),
    // The latest reviewed snapshot per run. An unreviewed run has none, so it is absent —
    // which is the truthful answer, not a provisional register.
    db.query<{ payload_json: SnapshotPayload; end_date: Date | string | null }>(
      `SELECT DISTINCT ON (s.course_run_id) s.payload_json, r.end_date
       FROM nzi_console.training_run_snapshots s
       JOIN nzi_console.training_course_runs r ON (r.organisation_id,r.course_run_id)=(s.organisation_id,s.course_run_id)
       ORDER BY s.course_run_id, s.snapshot_version DESC`),
    db.query<{ training_product_id: string; product_name: string; certificate_valid_months: number | null }>(
      `SELECT training_product_id, product_name, certificate_valid_months FROM nzi_console.training_products`),
  ]);

  const validityByProduct = new Map(productRows.rows.map((row) => [row.training_product_id, row.certificate_valid_months]));

  const records: PortalTrainingRecord[] = [];
  for (const row of snapshotRows.rows) {
    const payload = row.payload_json;
    const courseLabel = payload.product?.name ?? "Training";
    // "Completed" is the last session the run actually delivered, not the run's planned end.
    const delivered = payload.sessions.filter((session) => session.status === "delivered" && session.date !== null).map((session) => session.date!);
    const completedOn = delivered.length > 0 ? delivered.sort().at(-1)! : dateOnly(row.end_date);
    const issued = new Map(payload.certificates.map((certificate) => [certificate.bookingId, certificate]));
    const validMonths = payload.product ? validityByProduct.get(payload.product.id) ?? null : null;

    for (const entry of payload.register) {
      // The slice rule, applied at the row: this client's own people only.
      if (entry.employerClientId !== input.clientId) continue;
      if (entry.attendanceStatus === "cancelled") continue;
      const certificate = issued.get(entry.bookingId);
      records.push({
        bookingId: entry.bookingId,
        personName: entry.personName,
        courseLabel,
        completedOn,
        attendancePct: entry.attendancePct,
        certificate: certificate
          ? {
            state: "issued", verifyCode: certificate.verifyCode, certificateNumber: certificate.certificateNumber,
            validUntil: validMonths !== null && completedOn !== null ? addMonths(completedOn, validMonths) : null,
          }
          : entry.certificate === "held"
            ? { state: "pending", reason: "Waiting on the trainee's consent to issue." }
            : entry.certificate === "eligible"
              ? { state: "pending", reason: "Earned — being issued." }
              : { state: "not-earned", reason: `Attendance was ${entry.attendancePct}%, below what the course requires.` },
      });
    }
  }
  records.sort((a, b) => a.personName.localeCompare(b.personName) || a.courseLabel.localeCompare(b.courseLabel));

  // The skills grid, built only from certificates that were actually issued. A course with
  // no validity set never reads "refresher due" — that would be a date nobody agreed.
  const people = [...new Set(records.map((record) => record.personName))].sort((a, b) => a.localeCompare(b));
  const courses = [...new Set(records.filter((record) => record.certificate.state === "issued").map((record) => record.courseLabel))].sort((a, b) => a.localeCompare(b));
  const cells: Record<string, Record<string, PortalTrainingSkillCell>> = {};
  for (const person of people) {
    cells[person] = Object.fromEntries(courses.map((course) => [course, "none" as PortalTrainingSkillCell]));
  }
  for (const record of records) {
    if (record.certificate.state !== "issued" || !courses.includes(record.courseLabel)) continue;
    const lapsed = record.certificate.validUntil !== null && record.certificate.validUntil < input.asAt;
    const held = cells[record.personName]![record.courseLabel];
    // The best-standing certificate a person holds for a course is the one that counts —
    // a lapsed one does not undo a later current one.
    cells[record.personName]![record.courseLabel] = held === "current" ? "current" : lapsed ? "refresher-due" : "current";
  }

  return {
    clientName: clientRows.rows[0]?.name ?? null,
    places: trainingPlaceGroups(entitlementRows.rows.map((row) => ({
      id: row.entitlement_id, sourceJobId: row.source_job_id, sourceJobNumber: row.source_job_number,
      courseLabel: row.course_label ?? "", status: row.status as never,
      expiresAt: dateOnly(row.expires_at), defaultFromJobEnd: row.default_from_job_end,
    })), input.asAt),
    records,
    skills: { people, courses, cells },
    asAt: input.asAt,
  };
}
