import { dateOnlyOrNull } from "./dates";
import type { Queryable } from "./postgres";
import type {
  TrainingBooking, TrainingCertificate, TrainingCourseRun, TrainingCourseSession,
  TrainingEntitlement, TrainingProduct, TrainingSessionAttendance,
} from "@nzi/contracts";

/**
 * Reading a training run and everything hanging off it. Read-only and dependency-free, so
 * the job screen, the client portal and the trainee portal can all use it without a cycle
 * through the command modules — and so they all read the same rows.
 */

const iso = (value: Date | string | null) => value === null ? null : value instanceof Date ? value.toISOString() : String(value);

/** A booking, with the person it belongs to resolved and its employer-of-the-day intact. */
export type TrainingBookingRecord = TrainingBooking & {
  traineeId: string | null;
  traineeName: string | null;
  traineeEmail: string | null;
  employerClientId: string | null;
  employerName: string | null;
  /** True when the employer on the booking is not the client this run belongs to. */
  isGuest: boolean;
};

export type TrainingRunRecord = {
  run: TrainingCourseRun & { workflowStageKey: string; reviewStatus: string; reviewedVersion: number | null; version: number };
  product: TrainingProduct | null;
  sessions: TrainingCourseSession[];
  bookings: TrainingBookingRecord[];
  attendance: TrainingSessionAttendance[];
  certificates: TrainingCertificate[];
  /** Every place granted to this run's client, whatever run it was used on. */
  entitlements: Array<TrainingEntitlement & { sourceJobNumber: string; defaultFromJobEnd: boolean; courseLabel: string }>;
  /** The minimum attendance the product's policy requires, defaulting to the platform's 80%. */
  minAttendancePct: number;
};

export async function listTrainingRunsForJob(db: Queryable, jobId: string): Promise<TrainingRunRecord[]> {
  const runs = await db.query<{
    course_run_id: string; job_id: string; training_product_id: string | null; run_name: string | null; course_code: string | null;
    total_hours: string | null; delivery_mode: string; capacity: number | null; min_attendees: number | null;
    status: string; workflow_stage_key: string; start_date: Date | string | null; end_date: Date | string | null;
    venue_name: string | null; venue_address: string | null; online_meeting_url: string | null; online_meeting_id: string | null;
    online_passcode: string | null; notes: string; version: number; review_status: string; reviewed_version: number | null;
    client_id: string;
  }>(`SELECT r.course_run_id,r.job_id,r.training_product_id,r.run_name,r.course_code,r.total_hours::text,r.delivery_mode,
             r.capacity,r.min_attendees,r.status,r.workflow_stage_key,r.start_date,r.end_date,r.venue_name,r.venue_address,
             r.online_meeting_url,r.online_meeting_id,r.online_passcode,r.notes,r.version,r.review_status,r.reviewed_version,
             j.client_id
      FROM nzi_console.training_course_runs r
      JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(r.organisation_id,r.job_id)
      WHERE r.job_id=$1 ORDER BY r.start_date NULLS LAST, r.course_run_id`, [jobId]);
  if (runs.rows.length === 0) return [];
  const runIds = runs.rows.map((row) => row.course_run_id);
  const clientId = runs.rows[0]!.client_id;

  const [products, sessions, bookings, attendance, certificates, entitlements] = await Promise.all([
    db.query<{ training_product_id: string; product_code: string | null; product_name: string; description: string | null; default_hours: string | null; default_delivery_mode: string | null; certificate_policy: string; certificate_min_attendance_pct: number; is_active: boolean }>(
      `SELECT training_product_id,product_code,product_name,description,default_hours::text,default_delivery_mode,certificate_policy,certificate_min_attendance_pct,is_active
       FROM nzi_console.training_products`),
    db.query<{ session_id: string; course_run_id: string; session_title: string | null; session_date: Date | string | null; start_time: string | null; end_time: string | null; session_hours: string | null; delivery_mode: string | null; venue_name: string | null; venue_address: string | null; online_meeting_url: string | null; online_passcode: string | null; status: string; notes: string }>(
      `SELECT session_id,course_run_id,session_title,session_date,start_time,end_time,session_hours::text,delivery_mode,venue_name,venue_address,online_meeting_url,online_passcode,status,notes
       FROM nzi_console.training_course_sessions WHERE course_run_id = ANY($1::text[]) ORDER BY session_date NULLS LAST, start_time NULLS LAST, session_id`, [runIds]),
    db.query<{ booking_id: string; course_run_id: string; client_id: string | null; participant_type: string; booking_source: string; person_name: string; person_email: string | null; billing_status: string; attendance_status: string; consent_status: string; entitlement_id: string | null; trainee_id: string | null; trainee_name: string | null; trainee_email: string | null; employer_name: string | null }>(
      `SELECT b.booking_id,b.course_run_id,b.client_id,b.participant_type,b.booking_source,b.person_name,b.person_email,
              b.billing_status,b.attendance_status,b.consent_status,b.entitlement_id,b.trainee_id,
              t.full_name AS trainee_name, t.personal_email AS trainee_email, c.name AS employer_name
       FROM nzi_console.training_bookings b
       LEFT JOIN nzi_console.trainees t ON (t.organisation_id,t.trainee_id)=(b.organisation_id,b.trainee_id)
       LEFT JOIN nzi_console.clients c ON (c.organisation_id,c.client_id)=(b.organisation_id,b.client_id)
       WHERE b.course_run_id = ANY($1::text[]) ORDER BY b.person_name, b.booking_id`, [runIds]),
    db.query<{ attendance_id: string; session_id: string; booking_id: string; attendance_status: string; attendance_minutes: number | null; notes: string }>(
      `SELECT a.attendance_id,a.session_id,a.booking_id,a.attendance_status,a.attendance_minutes,a.notes
       FROM nzi_console.training_session_attendance a
       JOIN nzi_console.training_course_sessions s ON (s.organisation_id,s.session_id)=(a.organisation_id,a.session_id)
       WHERE s.course_run_id = ANY($1::text[])`, [runIds]),
    db.query<{ certificate_id: string; course_run_id: string; booking_id: string; certificate_number: string; verify_code: string; status: string; version: number; attended_minutes: number; required_minutes: number; attendance_pct: string; certificate_hash: string; issued_by: string; issued_at: Date | string; revoked_at: Date | string | null; revoke_reason: string | null }>(
      `SELECT certificate_id,course_run_id,booking_id,certificate_number,verify_code,status,version,attended_minutes,required_minutes,attendance_pct::text,certificate_hash,issued_by,issued_at,revoked_at,revoke_reason
       FROM nzi_console.training_certificates WHERE course_run_id = ANY($1::text[])`, [runIds]),
    // Every place this client holds, from whichever CRP job granted it.
    db.query<{ entitlement_id: string; source_job_id: string; source_job_number: string; source_client_id: string; entitlement_type: string; origin: string; status: string; allocated_to_booking_id: string | null; allocated_course_run_id: string | null; reserved_at: Date | string | null; consumed_at: Date | string | null; expires_at: Date | string | null; default_from_job_end: boolean; grant_note: string; course_label: string | null }>(
      `SELECT e.entitlement_id,e.source_job_id,e.source_job_number,e.source_client_id,e.entitlement_type,e.origin,e.status,
              e.allocated_to_booking_id,e.allocated_course_run_id,e.reserved_at,e.consumed_at,e.expires_at,e.default_from_job_end,e.grant_note,
              p.product_name AS course_label
       FROM nzi_console.training_entitlements e
       LEFT JOIN nzi_console.training_course_runs r ON (r.organisation_id,r.course_run_id)=(e.organisation_id,e.allocated_course_run_id)
       LEFT JOIN nzi_console.training_products p ON (p.organisation_id,p.training_product_id)=(r.organisation_id,r.training_product_id)
       WHERE e.source_client_id=$1 ORDER BY e.source_job_number, e.entitlement_id`, [clientId]),
  ]);

  const productById = new Map(products.rows.map((row) => [row.training_product_id, row]));
  return runs.rows.map((row) => {
    const product = row.training_product_id ? productById.get(row.training_product_id) ?? null : null;
    const runBookings = bookings.rows.filter((booking) => booking.course_run_id === row.course_run_id);
    const bookingIds = new Set(runBookings.map((booking) => booking.booking_id));
    return {
      run: {
        id: row.course_run_id, jobId: row.job_id, trainingProductId: row.training_product_id,
        runName: row.run_name, courseCode: row.course_code,
        totalHours: row.total_hours === null ? null : Number(row.total_hours),
        deliveryMode: row.delivery_mode, capacity: row.capacity, minAttendees: row.min_attendees,
        status: row.status, workflowStageKey: row.workflow_stage_key,
        startDate: dateOnlyOrNull(row.start_date), endDate: dateOnlyOrNull(row.end_date),
        venueName: row.venue_name, venueAddress: row.venue_address,
        onlineMeetingUrl: row.online_meeting_url, onlineMeetingId: row.online_meeting_id, onlinePasscode: row.online_passcode,
        notes: row.notes, version: row.version, reviewStatus: row.review_status, reviewedVersion: row.reviewed_version,
      } as TrainingRunRecord["run"],
      product: product === null ? null : {
        id: product.training_product_id, productCode: product.product_code, productName: product.product_name,
        description: product.description, defaultHours: product.default_hours === null ? null : Number(product.default_hours),
        defaultDeliveryMode: product.default_delivery_mode, certificatePolicy: product.certificate_policy,
        certificateMinAttendancePct: product.certificate_min_attendance_pct, isActive: product.is_active,
      } as TrainingProduct,
      sessions: sessions.rows.filter((session) => session.course_run_id === row.course_run_id).map((session) => ({
        id: session.session_id, courseRunId: session.course_run_id, sessionTitle: session.session_title,
        sessionDate: dateOnlyOrNull(session.session_date), startTime: session.start_time, endTime: session.end_time,
        sessionHours: session.session_hours === null ? null : Number(session.session_hours),
        deliveryMode: session.delivery_mode, venueName: session.venue_name, venueAddress: session.venue_address,
        onlineMeetingUrl: session.online_meeting_url, onlinePasscode: session.online_passcode,
        status: session.status, notes: session.notes,
      })) as TrainingCourseSession[],
      bookings: runBookings.map((booking) => ({
        id: booking.booking_id, courseRunId: booking.course_run_id, clientId: booking.client_id,
        participantType: booking.participant_type, bookingSource: booking.booking_source,
        personName: booking.trainee_name ?? booking.person_name, personEmail: booking.trainee_email ?? booking.person_email,
        billingStatus: booking.billing_status, attendanceStatus: booking.attendance_status,
        consentStatus: booking.consent_status, entitlementId: booking.entitlement_id,
        traineeId: booking.trainee_id, traineeName: booking.trainee_name, traineeEmail: booking.trainee_email,
        employerClientId: booking.client_id, employerName: booking.employer_name,
        // A guest is someone another employer sent — allowed, and labelled as such.
        isGuest: booking.client_id !== null && booking.client_id !== row.client_id,
      })) as TrainingBookingRecord[],
      attendance: attendance.rows.filter((entry) => bookingIds.has(entry.booking_id)).map((entry) => ({
        id: entry.attendance_id, sessionId: entry.session_id, bookingId: entry.booking_id,
        attendanceStatus: entry.attendance_status, attendanceMinutes: entry.attendance_minutes, notes: entry.notes,
      })) as TrainingSessionAttendance[],
      certificates: certificates.rows.filter((certificate) => certificate.course_run_id === row.course_run_id).map((certificate) => ({
        id: certificate.certificate_id, courseRunId: certificate.course_run_id, bookingId: certificate.booking_id,
        certificateNumber: certificate.certificate_number, verifyCode: certificate.verify_code, status: certificate.status,
        version: certificate.version, attendedMinutes: certificate.attended_minutes, requiredMinutes: certificate.required_minutes,
        attendancePct: Number(certificate.attendance_pct), certificateHash: certificate.certificate_hash,
        issuedBy: certificate.issued_by, issuedAt: iso(certificate.issued_at), revokedAt: iso(certificate.revoked_at),
        revokeReason: certificate.revoke_reason,
      })) as unknown as TrainingCertificate[],
      entitlements: entitlements.rows.map((entitlement) => ({
        id: entitlement.entitlement_id, sourceJobId: entitlement.source_job_id, sourceJobNumber: entitlement.source_job_number,
        sourceClientId: entitlement.source_client_id, entitlementType: entitlement.entitlement_type, origin: entitlement.origin,
        status: entitlement.status, allocatedToBookingId: entitlement.allocated_to_booking_id,
        allocatedCourseRunId: entitlement.allocated_course_run_id,
        reservedAt: iso(entitlement.reserved_at), consumedAt: iso(entitlement.consumed_at), expiresAt: iso(entitlement.expires_at),
        defaultFromJobEnd: entitlement.default_from_job_end, grantNote: entitlement.grant_note,
        courseLabel: entitlement.course_label ?? "",
      })) as unknown as TrainingRunRecord["entitlements"],
      minAttendancePct: product?.certificate_min_attendance_pct ?? 80,
    };
  });
}

/** One run, for the workspace and for the snapshot builder. */
export async function getTrainingRun(db: Queryable, courseRunId: string): Promise<TrainingRunRecord | null> {
  const found = await db.query<{ job_id: string }>(`SELECT job_id FROM nzi_console.training_course_runs WHERE course_run_id=$1`, [courseRunId]);
  const jobId = found.rows[0]?.job_id;
  if (!jobId) return null;
  const runs = await listTrainingRunsForJob(db, jobId);
  return runs.find((run) => run.run.id === courseRunId) ?? null;
}
