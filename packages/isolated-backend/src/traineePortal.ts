import type { Queryable } from "./postgres";

/**
 * Trainee portal read model — one person's whole training record.
 *
 * This is the mirror image of the client-portal view, and deliberately so. The employer
 * sees its own slice of many people; the person sees all of themselves, across every
 * employer they have had. That is the point of a person-centric trainee record: the
 * training is theirs, and it should still be theirs after they move on.
 *
 * The employer on each entry is the one frozen at booking, never re-read from the person's
 * current employer — so a past course stays attributed to whoever arranged it. Updating
 * your details never rewrites your history.
 *
 * Completed training is read from reviewed run snapshots; in-progress training is read
 * from the live rows, and says so, because a run still being delivered has no frozen
 * register to quote.
 */

export type TraineeTrainingEntry = {
  courseRunId: string;
  courseName: string;
  /** Who arranged it, as at the booking. Null where no employer was recorded. */
  employerName: string | null;
  employerIsCurrent: boolean;
  sessionsTotal: number;
  sessionsAttended: number;
  attendancePct: number;
  cpdHours: number | null;
  completedOn: string | null;
  certificate: { certificateNumber: string; verifyCode: string; issuedOn: string } | null;
  /** `confirmed` is from a reviewed snapshot; `in-progress` is live and still moving. */
  standing: "confirmed" | "in-progress";
  /** For an in-progress run, what still stands between them and a certificate. */
  remaining: string | null;
};

export type TraineeUpcomingSession = {
  sessionId: string;
  courseName: string;
  sessionTitle: string | null;
  sessionDate: string;
  startTime: string | null;
  endTime: string | null;
  deliveryMode: string | null;
  venueName: string | null;
  /** True once the joining link exists; the link itself is never sent to the page early. */
  hasJoiningLink: boolean;
};

export type TraineeDetails = {
  fullName: string;
  email: string;
  phone: string | null;
  currentEmployerName: string | null;
  /** Three states, not a checkbox: nobody has ever been asked is not the same as "no". */
  marketingConsent: "unknown" | "granted" | "declined";
  /** An email change in flight, so the page can say it is waiting rather than look stuck. */
  pendingEmail: string | null;
};

export type TraineePortalReadModel = {
  details: TraineeDetails;
  completed: TraineeTrainingEntry[];
  inProgress: TraineeTrainingEntry[];
  upcoming: TraineeUpcomingSession[];
  asAt: string;
};

type SnapshotPayload = {
  courseRunId: string;
  product: { id: string; name: string; minAttendancePct: number } | null;
  sessions: Array<{ id: string; date: string | null; minutes: number; status: string }>;
  register: Array<{
    bookingId: string; traineeId: string | null; personName: string;
    employerClientId: string | null; attendancePct: number;
    attendanceStatus: string; certificate: "eligible" | "held" | "not-eligible";
  }>;
  certificates: Array<{ bookingId: string; certificateNumber: string; verifyCode: string }>;
};

const dateOnly = (value: Date | string | null) => value === null ? null : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

export async function getTraineePortal(
  db: Queryable,
  input: { traineeId: string; asAt: string },
): Promise<TraineePortalReadModel> {
  const [traineeRows, bookingRows, snapshotRows, sessionRows, attendanceRows, pendingRows] = await Promise.all([
    db.query<{ full_name: string; personal_email: string; phone: string; marketing_consent: string; current_employer_client_id: string | null; employer_name: string | null; current_employer_name: string }>(
      // The employer they say they work for now. Where it is a client we know, that name
      // wins; otherwise their own words stand — a person who moves to a company NZI has
      // never worked with should still be able to say where they are.
      `SELECT t.full_name, t.personal_email, t.phone, t.marketing_consent, t.current_employer_client_id,
              t.current_employer_name, c.name AS employer_name
       FROM nzi_console.trainees t
       LEFT JOIN nzi_console.clients c ON (c.organisation_id,c.client_id)=(t.organisation_id,t.current_employer_client_id)
       WHERE t.trainee_id=$1`, [input.traineeId]),
    // Every booking this person holds, with the employer frozen at booking and the run it
    // belongs to. Person-scoped, never employer-scoped — this is the whole point.
    db.query<{ booking_id: string; course_run_id: string; attendance_status: string; client_id: string | null; employer_name: string | null; course_name: string; total_hours: string | null; min_attendance_pct: number; review_status: string; end_date: Date | string | null }>(
      `SELECT b.booking_id, b.course_run_id, b.attendance_status, b.client_id,
              c.name AS employer_name,
              coalesce(p.product_name, r.run_name, 'Training') AS course_name,
              coalesce(r.total_hours, p.default_hours)::text AS total_hours,
              coalesce(p.certificate_min_attendance_pct, 80) AS min_attendance_pct,
              r.review_status, r.end_date
       FROM nzi_console.training_bookings b
       JOIN nzi_console.training_course_runs r ON (r.organisation_id,r.course_run_id)=(b.organisation_id,b.course_run_id)
       LEFT JOIN nzi_console.training_products p ON (p.organisation_id,p.training_product_id)=(r.organisation_id,r.training_product_id)
       LEFT JOIN nzi_console.clients c ON (c.organisation_id,c.client_id)=(b.organisation_id,b.client_id)
       WHERE b.trainee_id=$1 AND b.attendance_status <> 'cancelled'`, [input.traineeId]),
    db.query<{ course_run_id: string; payload_json: SnapshotPayload }>(
      `SELECT DISTINCT ON (course_run_id) course_run_id, payload_json
       FROM nzi_console.training_run_snapshots ORDER BY course_run_id, snapshot_version DESC`),
    db.query<{ session_id: string; course_run_id: string; session_title: string | null; session_date: Date | string | null; start_time: string | null; end_time: string | null; delivery_mode: string | null; venue_name: string | null; online_meeting_url: string | null; status: string }>(
      `SELECT s.session_id, s.course_run_id, s.session_title, s.session_date, s.start_time, s.end_time,
              s.delivery_mode, s.venue_name, s.online_meeting_url, s.status
       FROM nzi_console.training_course_sessions s
       WHERE s.course_run_id IN (SELECT course_run_id FROM nzi_console.training_bookings WHERE trainee_id=$1)`,
      [input.traineeId]),
    db.query<{ booking_id: string; session_id: string; attendance_status: string }>(
      `SELECT a.booking_id, a.session_id, a.attendance_status
       FROM nzi_console.training_session_attendance a
       WHERE a.booking_id IN (SELECT booking_id FROM nzi_console.training_bookings WHERE trainee_id=$1)`,
      [input.traineeId]),
    db.query<{ new_email: string }>(
      `SELECT new_email FROM nzi_console.trainee_email_changes
       WHERE trainee_id=$1 AND confirmed_at IS NULL AND expires_at > now()
       ORDER BY requested_at DESC LIMIT 1`, [input.traineeId]),
  ]);

  const trainee = traineeRows.rows[0];
  const details: TraineeDetails = {
    fullName: trainee?.full_name ?? "",
    email: trainee?.personal_email ?? "",
    phone: trainee?.phone?.trim() ? trainee.phone : null,
    currentEmployerName: trainee?.employer_name ?? (trainee?.current_employer_name?.trim() ? trainee.current_employer_name : null),
    marketingConsent: (trainee?.marketing_consent ?? "unknown") as TraineeDetails["marketingConsent"],
    pendingEmail: pendingRows.rows[0]?.new_email ?? null,
  };

  const snapshotByRun = new Map(snapshotRows.rows.map((row) => [row.course_run_id, row.payload_json]));
  const currentEmployerId = trainee?.current_employer_client_id ?? null;

  const completed: TraineeTrainingEntry[] = [];
  const inProgress: TraineeTrainingEntry[] = [];

  for (const booking of bookingRows.rows) {
    const runSessions = sessionRows.rows.filter((session) => session.course_run_id === booking.course_run_id);
    const snapshot = snapshotByRun.get(booking.course_run_id) ?? null;
    const entry = snapshot?.register.find((row) => row.bookingId === booking.booking_id) ?? null;
    const confirmed = booking.review_status === "approved" && entry !== null;

    const attended = attendanceRows.rows.filter((row) => row.booking_id === booking.booking_id && row.attendance_status === "present").length;
    const delivered = runSessions.filter((session) => session.status === "delivered");
    const lastDelivered = delivered.map((session) => dateOnly(session.session_date)).filter((date): date is string => date !== null).sort().at(-1) ?? null;

    const shared: TraineeTrainingEntry = {
      courseRunId: booking.course_run_id,
      courseName: booking.course_name,
      employerName: booking.employer_name,
      // Said plainly on the page: "(previous employer)" is a fact about them, not a demotion.
      employerIsCurrent: booking.client_id !== null && booking.client_id === currentEmployerId,
      sessionsTotal: runSessions.length,
      sessionsAttended: attended,
      attendancePct: entry?.attendancePct ?? (runSessions.length === 0 ? 0 : Math.round((attended / runSessions.length) * 100)),
      cpdHours: booking.total_hours === null ? null : Number(booking.total_hours),
      completedOn: confirmed ? lastDelivered ?? dateOnly(booking.end_date) : null,
      certificate: null,
      standing: confirmed ? "confirmed" : "in-progress",
      remaining: null,
    };

    if (confirmed && snapshot && entry) {
      const certificate = snapshot.certificates.find((item) => item.bookingId === booking.booking_id) ?? null;
      completed.push({
        ...shared,
        certificate: certificate
          ? { certificateNumber: certificate.certificateNumber, verifyCode: certificate.verifyCode, issuedOn: shared.completedOn ?? "" }
          : null,
        remaining: certificate
          ? null
          : entry.certificate === "held"
            ? "Waiting on your consent before the certificate can be issued."
            : entry.certificate === "eligible"
              ? "Earned — your certificate is being issued."
              : `Attendance was ${entry.attendancePct}%, below the ${snapshot.product?.minAttendancePct ?? 80}% this course requires.`,
      });
    } else {
      const outstanding = runSessions.length - delivered.length;
      inProgress.push({
        ...shared,
        // Only ever what is actually left, never a predicted outcome.
        remaining: outstanding > 0
          ? `${outstanding} session${outstanding === 1 ? "" : "s"} remaining · certificate on completion (≥${booking.min_attendance_pct}% attendance)`
          : "All sessions delivered — your record is being confirmed by the NZI team.",
      });
    }
  }

  completed.sort((a, b) => (b.completedOn ?? "").localeCompare(a.completedOn ?? "") || a.courseName.localeCompare(b.courseName));
  inProgress.sort((a, b) => a.courseName.localeCompare(b.courseName));

  const courseByRun = new Map(bookingRows.rows.map((row) => [row.course_run_id, row.course_name]));
  const upcoming: TraineeUpcomingSession[] = sessionRows.rows
    .filter((session) => session.status !== "delivered" && session.status !== "cancelled")
    .map((session) => ({ ...session, date: dateOnly(session.session_date) }))
    .filter((session): session is typeof session & { date: string } => session.date !== null && session.date >= input.asAt)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.start_time ?? "").localeCompare(b.start_time ?? ""))
    .map((session) => ({
      sessionId: session.session_id,
      courseName: courseByRun.get(session.course_run_id) ?? "Training",
      sessionTitle: session.session_title,
      sessionDate: session.date,
      startTime: session.start_time,
      endTime: session.end_time,
      deliveryMode: session.delivery_mode,
      venueName: session.venue_name,
      // Whether a link exists, not the link: a joining URL is issued near the session, and
      // this read model is not the place it leaks early.
      hasJoiningLink: session.online_meeting_url !== null && session.online_meeting_url.trim() !== "",
    }));

  return { details, completed, inProgress, upcoming, asAt: input.asAt };
}
