// The training run's commands — bookings, attendance, certificates, places and review.
//
// Two things here are load-bearing and deliberately delegate to the database rather than
// to application logic:
//
//   Reserving a place calls reserve_training_entitlement(), which locks the row and
//   refuses anything that is not 'available'. Two consultants booking the last place at
//   the same moment cannot both win, because the guarantee is in the transaction, not in
//   a check we remembered to write.
//
//   Issuing certificates consumes the place the booking was funded from, through
//   consume_training_entitlement(), for the same reason.
import { createHash, randomUUID } from "node:crypto";
import {
  trainingCertificateDecision, isAllowedTrainingRunStageTransition,
  type CommandContext, type CommandInputMap,
} from "@nzi/contracts";
import { getTrainingRun } from "./trainingRunRecords";
import { VersionConflictError } from "./errors";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
export * from "./trainingRunRecords";

/** The same stable-key hash the CRP and LCA snapshots use, so evidence is comparable. */
const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)]));
  }
  return value;
};
const hashOf = (payload: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex")}`;

export type CreateTrainingBookingResult = { bookingId: string; courseRunId: string; entitlementId: string | null; placeReserved: boolean };

/**
 * Book a person onto a run.
 *
 * The booking records who the person is (a trainee, not a typed name) and freezes the
 * employer and funding that applied at the time. If a place funds it, that place is
 * reserved in the same transaction — so a booking never exists without the place it
 * claimed, and a place is never spent without a booking.
 */
export function createTrainingBooking(pool: PoolLike, input: CommandInputMap["training.booking.create"], context: CommandContext): Promise<StoredOutcome<CreateTrainingBookingResult>> {
  return runPostgresCommand(pool, "training.booking.create", input, context, async (db) => {
    const run = await db.query<{ course_run_id: string; capacity: number | null; workflow_stage_key: string }>(
      `SELECT course_run_id, capacity, workflow_stage_key FROM nzi_console.training_course_runs
       WHERE organisation_id=$1 AND course_run_id=$2 FOR UPDATE`,
      [context.organisationId, input.courseRunId]);
    if (!run.rows[0]) throw new CommandValidationError([{ field: "courseRunId", code: "NOT_FOUND", message: "That run does not exist." }]);

    const trainee = await db.query<{ trainee_id: string; full_name: string; personal_email: string; status: string }>(
      `SELECT trainee_id, full_name, personal_email, status FROM nzi_console.trainees WHERE organisation_id=$1 AND trainee_id=$2`,
      [context.organisationId, input.traineeId]);
    const person = trainee.rows[0];
    if (!person) throw new CommandValidationError([{ field: "traineeId", code: "NOT_FOUND", message: "That trainee does not exist." }]);
    if (person.status === "deactivated") throw new CommandValidationError([{ field: "traineeId", code: "TRAINEE_INACTIVE", message: "That trainee record is deactivated." }]);

    const already = await db.query<{ booking_id: string }>(
      `SELECT booking_id FROM nzi_console.training_bookings
       WHERE organisation_id=$1 AND course_run_id=$2 AND trainee_id=$3 AND attendance_status <> 'cancelled'`,
      [context.organisationId, input.courseRunId, input.traineeId]);
    if (already.rows[0]) throw new CommandValidationError([{ field: "traineeId", code: "ALREADY_BOOKED", message: "This person is already booked onto this run." }]);

    // Over capacity is a waitlist, not a refusal — the model has the state, so use it.
    const booked = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM nzi_console.training_bookings
       WHERE organisation_id=$1 AND course_run_id=$2 AND attendance_status NOT IN ('cancelled','waitlisted')`,
      [context.organisationId, input.courseRunId]);
    const capacity = run.rows[0]!.capacity;
    const atCapacity = capacity !== null && Number(booked.rows[0]?.count ?? 0) >= capacity;

    const bookingId = randomUUID();
    const fundedByPlace = Boolean(input.entitlementId);
    const billingStatus = fundedByPlace ? "free_place" : input.billingStatus ?? "pending";

    await db.query(
      `INSERT INTO nzi_console.training_bookings
        (organisation_id, booking_id, course_run_id, client_id, participant_type, booking_source,
         person_name, person_email, billing_status, attendance_status, consent_status, entitlement_id, trainee_id, notes)
       VALUES ($1,$2,$3,$4,$5,'manual',$6,$7,$8,$9,$10,$11,$12,$13)`,
      [context.organisationId, bookingId, input.courseRunId, input.employerClientId, input.participantType,
        person.full_name, person.personal_email, billingStatus, atCapacity ? "waitlisted" : "booked",
        input.consentStatus ?? "unknown", input.entitlementId ?? null, input.traineeId, input.notes ?? ""]);

    // The place is claimed by the database, not by us: locked, status-guarded, one winner.
    if (input.entitlementId) {
      try {
        await db.query(`SELECT nzi_console.reserve_training_entitlement($1,$2,$3,$4)`,
          [context.organisationId, input.entitlementId, bookingId, input.courseRunId]);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "55000") throw new CommandValidationError([{ field: "entitlementId", code: "PLACE_UNAVAILABLE", message: "That place has already been taken. Choose another." }]);
        if (code === "no_data_found") throw new CommandValidationError([{ field: "entitlementId", code: "NOT_FOUND", message: "That place does not exist." }]);
        throw error;
      }
    }

    return {
      data: { bookingId, courseRunId: input.courseRunId, entitlementId: input.entitlementId ?? null, placeReserved: fundedByPlace },
      entityType: "training_booking", entityId: bookingId, topic: "training.booking.created",
      after: { courseRunId: input.courseRunId, traineeId: input.traineeId, employerClientId: input.employerClientId, entitlementId: input.entitlementId ?? null, waitlisted: atCapacity },
    };
  });
}

export type SetTrainingAttendanceResult = { sessionId: string; bookingId: string; attendanceStatus: string };

/** Attendance is captured per session; the percentage is always derived from these rows. */
export function setTrainingAttendance(pool: PoolLike, input: CommandInputMap["training.attendance.set"], context: CommandContext): Promise<StoredOutcome<SetTrainingAttendanceResult>> {
  return runPostgresCommand(pool, "training.attendance.set", input, context, async (db) => {
    const pair = await db.query<{ session_minutes: string | null; course_run_id: string }>(
      `SELECT (s.session_hours * 60)::text AS session_minutes, s.course_run_id
       FROM nzi_console.training_course_sessions s
       JOIN nzi_console.training_bookings b ON (b.organisation_id,b.course_run_id)=(s.organisation_id,s.course_run_id)
       WHERE s.organisation_id=$1 AND s.session_id=$2 AND b.booking_id=$3`,
      [context.organisationId, input.sessionId, input.bookingId]);
    if (!pair.rows[0]) throw new CommandValidationError([{ field: "bookingId", code: "NOT_ON_RUN", message: "That booking is not on the same run as that session." }]);

    const minutes = input.attendanceStatus === "present"
      ? input.attendanceMinutes ?? (pair.rows[0].session_minutes === null ? 0 : Math.round(Number(pair.rows[0].session_minutes)))
      : 0;
    const existing = await db.query<{ attendance_id: string; attendance_status: string }>(
      `SELECT attendance_id, attendance_status FROM nzi_console.training_session_attendance
       WHERE organisation_id=$1 AND session_id=$2 AND booking_id=$3 FOR UPDATE`,
      [context.organisationId, input.sessionId, input.bookingId]);
    const previous = existing.rows[0] ?? null;

    if (previous) {
      await db.query(
        `UPDATE nzi_console.training_session_attendance SET attendance_status=$4, attendance_minutes=$5, notes=$6
         WHERE organisation_id=$1 AND session_id=$2 AND booking_id=$3`,
        [context.organisationId, input.sessionId, input.bookingId, input.attendanceStatus, minutes, input.notes ?? ""]);
    } else {
      await db.query(
        `INSERT INTO nzi_console.training_session_attendance
          (organisation_id, attendance_id, session_id, booking_id, attendance_status, attendance_minutes, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [context.organisationId, randomUUID(), input.sessionId, input.bookingId, input.attendanceStatus, minutes, input.notes ?? ""]);
    }

    return {
      data: { sessionId: input.sessionId, bookingId: input.bookingId, attendanceStatus: input.attendanceStatus },
      entityType: "training_session_attendance", entityId: `${input.sessionId}:${input.bookingId}`, topic: "training.attendance.set",
      ...(previous ? { before: { attendanceStatus: previous.attendance_status } } : {}),
      after: { attendanceStatus: input.attendanceStatus, attendanceMinutes: minutes },
    };
  });
}

export type IssueTrainingCertificatesResult = { courseRunId: string; issued: number; held: number; notEligible: number; certificateIds: string[] };

/**
 * Issue every certificate the policy allows.
 *
 * Policy-driven, so nobody hands one out by judgement: attendance is summed from the
 * session rows and compared against the product's threshold. A person who attended but
 * whose consent is not recorded is **held**, not refused — the certificate is theirs the
 * moment consent lands. Where a booking was funded by a place, issuing consumes it.
 */
export function issueTrainingCertificates(pool: PoolLike, input: CommandInputMap["training.certificate.issue"], context: CommandContext): Promise<StoredOutcome<IssueTrainingCertificatesResult>> {
  return runPostgresCommand(pool, "training.certificate.issue", input, context, async (db) => {
    const record = await getTrainingRun(db, input.courseRunId);
    if (!record) throw new CommandValidationError([{ field: "courseRunId", code: "NOT_FOUND", message: "That run does not exist." }]);
    if (record.run.version !== input.expectedRunVersion) throw new VersionConflictError(input.expectedRunVersion, record.run.version);

    const issuedIds: string[] = [];
    let held = 0, notEligible = 0;
    const alreadyIssued = new Set(record.certificates.filter((certificate) => certificate.status === "issued").map((certificate) => certificate.bookingId));

    for (const booking of record.bookings) {
      const decision = trainingCertificateDecision({
        booking, sessions: record.sessions, attendance: record.attendance, minAttendancePct: record.minAttendancePct,
      });
      if (decision.state === "held") { held += 1; continue; }
      if (decision.state === "not-eligible") { notEligible += 1; continue; }
      if (alreadyIssued.has(booking.id)) continue;

      const attended = record.attendance
        .filter((entry) => entry.bookingId === booking.id && entry.attendanceStatus !== "absent")
        .reduce((total, entry) => total + (entry.attendanceMinutes ?? 0), 0);
      const required = record.sessions.reduce((total, session) => total + Math.round((session.sessionHours ?? 0) * 60), 0);
      const certificateId = randomUUID();
      // The number is the organisation's reference; the verify code is what gets published,
      // so it carries enough entropy that certificates cannot be walked.
      const sequence = await db.query<{ next: string }>(
        `SELECT (count(*) + 1)::text AS next FROM nzi_console.training_certificates WHERE organisation_id=$1`, [context.organisationId]);
      const certificateNumber = `NZI-CERT-${String(sequence.rows[0]?.next ?? "1").padStart(5, "0")}`;
      const payload = {
        courseRunId: record.run.id, bookingId: booking.id, traineeId: booking.traineeId,
        personName: booking.personName, attendedMinutes: attended, requiredMinutes: required,
        attendancePct: decision.attendancePct, policy: { minAttendancePct: record.minAttendancePct },
        issuedBy: context.actorId,
      };
      const certificateHash = hashOf(payload);
      const verifyCode = `NZI-${createHash("sha256").update(`${certificateId}:${certificateHash}`).digest("hex").slice(0, 10).toUpperCase()}`;

      await db.query(
        `INSERT INTO nzi_console.training_certificates
          (organisation_id, certificate_id, course_run_id, booking_id, certificate_number, verify_code, status,
           attended_minutes, required_minutes, attendance_pct, policy_snapshot_json, certificate_hash, issued_by)
         VALUES ($1,$2,$3,$4,$5,$6,'issued',$7,$8,$9,$10,$11,$12)`,
        [context.organisationId, certificateId, record.run.id, booking.id, certificateNumber, verifyCode,
          attended, required, decision.attendancePct, JSON.stringify({ minAttendancePct: record.minAttendancePct }), certificateHash, context.actorId]);
      issuedIds.push(certificateId);

      // The place is spent when the training is certified, not when it was booked.
      if (booking.entitlementId) {
        try {
          await db.query(`SELECT nzi_console.consume_training_entitlement($1,$2)`, [context.organisationId, booking.entitlementId]);
        } catch (error) {
          // Already consumed is not a failure here: the place was spent by an earlier issue.
          if ((error as { code?: string }).code !== "55000") throw error;
        }
      }
    }

    return {
      data: { courseRunId: record.run.id, issued: issuedIds.length, held, notEligible, certificateIds: issuedIds },
      entityType: "training_course_run", entityId: record.run.id, topic: "training.certificates.issued",
      after: { issued: issuedIds.length, held, notEligible, minAttendancePct: record.minAttendancePct },
    };
  });
}

export type SetEntitlementExpiryResult = { entitlementIds: string[]; expiresAt: string | null; wasDefault: boolean };

/**
 * Move the expiry on a grant's places.
 *
 * The default comes from the granting job's end date. Moving it is a commercial decision
 * somebody makes, so it needs a reason, it is audited, and the default flag is cleared —
 * which is what lets the client portal distinguish "expires then because the job ended"
 * from "expires then because we agreed it".
 *
 * The grant moves as a unit. Every place in it carries the same date, so a partial move
 * would leave one strip quoting two expiries; the rows are locked in a stable order and
 * the whole set moves or none of it does.
 */
export function setTrainingEntitlementExpiry(pool: PoolLike, input: CommandInputMap["training.entitlement.expiry.set"], context: CommandContext): Promise<StoredOutcome<SetEntitlementExpiryResult>> {
  return runPostgresCommand(pool, "training.entitlement.expiry.set", input, context, async (db) => {
    const ids = [...new Set(input.entitlementIds)].sort();
    const current = await db.query<{ entitlement_id: string; source_job_id: string; source_client_id: string; status: string; expires_at: Date | string | null; default_from_job_end: boolean }>(
      `SELECT entitlement_id, source_job_id, source_client_id, status, expires_at, default_from_job_end
       FROM nzi_console.training_entitlements
       WHERE organisation_id=$1 AND entitlement_id = ANY($2::text[])
       ORDER BY entitlement_id FOR UPDATE`,
      [context.organisationId, ids]);
    if (current.rows.length !== ids.length) {
      throw new CommandValidationError([{ field: "entitlementIds", code: "NOT_FOUND", message: "One of those places no longer exists — reload the register." }]);
    }
    // The authorization check resolved one place's client. Every place must come from the
    // same grant, or a caller could move another client's date behind an id it does own.
    if (new Set(current.rows.map((row) => `${row.source_client_id}::${row.source_job_id}`)).size > 1) {
      throw new CommandValidationError([{ field: "entitlementIds", code: "MIXED_GRANT", message: "Those places come from different grants — move one grant at a time." }]);
    }
    const consumed = current.rows.filter((row) => row.status === "consumed");
    if (consumed.length > 0) {
      throw new CommandValidationError([{ field: "entitlementIds", code: "PLACE_CONSUMED", message: `${consumed.length} of those places ${consumed.length === 1 ? "has" : "have"} been used — expiry no longer applies to ${consumed.length === 1 ? "it" : "them"}.` }]);
    }

    const stamp = (value: Date | string | null) => value === null ? null : value instanceof Date ? value.toISOString() : String(value);
    await db.query(
      `UPDATE nzi_console.training_entitlements
       SET expires_at=$3, default_from_job_end=false, updated_at=now()
       WHERE organisation_id=$1 AND entitlement_id = ANY($2::text[])`,
      [context.organisationId, ids, input.expiresAt === null ? null : `${input.expiresAt}T23:59:59Z`]);

    // The grant is what the user moved, so the grant is the audited entity; the places it
    // covers are named in the payload rather than lost behind a count.
    const first = current.rows[0]!;
    return {
      data: { entitlementIds: ids, expiresAt: input.expiresAt, wasDefault: current.rows.every((row) => row.default_from_job_end) },
      entityType: "training_entitlement_grant", entityId: first.source_job_id, topic: "training.entitlement.expiry_set",
      before: { entitlements: current.rows.map((row) => ({ entitlementId: row.entitlement_id, expiresAt: stamp(row.expires_at), defaultFromJobEnd: row.default_from_job_end })) },
      after: { entitlementIds: ids, expiresAt: input.expiresAt, defaultFromJobEnd: false },
    };
  });
}

export type SetTrainingRunStageResult = { courseRunId: string; stage: string; version: number };

export function setTrainingRunStage(pool: PoolLike, input: CommandInputMap["training.run.stage.set"], context: CommandContext): Promise<StoredOutcome<SetTrainingRunStageResult>> {
  return runPostgresCommand(pool, "training.run.stage.set", input, context, async (db) => {
    const current = await db.query<{ workflow_stage_key: string; version: number }>(
      `SELECT workflow_stage_key, version FROM nzi_console.training_course_runs
       WHERE organisation_id=$1 AND course_run_id=$2 FOR UPDATE`,
      [context.organisationId, input.courseRunId]);
    const run = current.rows[0];
    if (!run) throw new CommandValidationError([{ field: "courseRunId", code: "NOT_FOUND", message: "That run does not exist." }]);
    if (run.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, run.version);
    if (run.workflow_stage_key !== input.fromStage) {
      throw new CommandValidationError([{ field: "fromStage", code: "STALE_STAGE", message: `The run has moved to ${run.workflow_stage_key} since this screen was loaded.` }]);
    }
    if (!isAllowedTrainingRunStageTransition(input.fromStage, input.toStage)) {
      throw new CommandValidationError([{ field: "toStage", code: "INVALID_TRANSITION", message: "A run moves one stage at a time." }]);
    }

    const saved = await db.query<{ version: number }>(
      `UPDATE nzi_console.training_course_runs SET workflow_stage_key=$3, version=version+1, updated_at=now(), updated_by=$4
       WHERE organisation_id=$1 AND course_run_id=$2 RETURNING version`,
      [context.organisationId, input.courseRunId, input.toStage, context.actorId]);

    return {
      data: { courseRunId: input.courseRunId, stage: input.toStage, version: saved.rows[0]!.version },
      entityType: "training_course_run", entityId: input.courseRunId, topic: "training.run.stage_changed",
      before: { stage: input.fromStage }, after: { stage: input.toStage, note: input.note ?? "" },
    };
  });
}

export type ReviewTrainingRunResult = { courseRunId: string; snapshotId: string; dataHash: string; reused: boolean; version: number };

/**
 * Reviewing the run freezes what happened: the attendance register and the certificates
 * issued, hashed so the same facts always produce the same snapshot. The family report and
 * both portals read this and recompute nothing — which is the only way three audiences can
 * be shown the same training and see the same numbers.
 */
export function reviewTrainingRun(pool: PoolLike, input: CommandInputMap["training.run.review"], context: CommandContext): Promise<StoredOutcome<ReviewTrainingRunResult>> {
  return runPostgresCommand(pool, "training.run.review", input, context, async (db) => {
    const record = await getTrainingRun(db, input.courseRunId);
    if (!record) throw new CommandValidationError([{ field: "courseRunId", code: "NOT_FOUND", message: "That run does not exist." }]);
    if (record.run.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, record.run.version);

    const payload = {
      courseRunId: record.run.id, jobId: record.run.jobId, runVersion: record.run.version,
      product: record.product ? { id: record.product.id, name: record.product.productName, minAttendancePct: record.minAttendancePct } : null,
      sessions: record.sessions.map((session) => ({
        id: session.id, title: session.sessionTitle, date: session.sessionDate,
        minutes: Math.round((session.sessionHours ?? 0) * 60), deliveryMode: session.deliveryMode, status: session.status,
      })),
      register: record.bookings.map((booking) => {
        const decision = trainingCertificateDecision({ booking, sessions: record.sessions, attendance: record.attendance, minAttendancePct: record.minAttendancePct });
        return {
          bookingId: booking.id, traineeId: booking.traineeId, personName: booking.personName,
          employerClientId: booking.employerClientId, entitlementId: booking.entitlementId,
          billingStatus: booking.billingStatus, attendanceStatus: booking.attendanceStatus,
          consentStatus: booking.consentStatus, attendancePct: decision.attendancePct, certificate: decision.state,
        };
      }),
      certificates: record.certificates.filter((certificate) => certificate.status === "issued").map((certificate) => ({
        certificateId: certificate.id, bookingId: certificate.bookingId,
        certificateNumber: (certificate as unknown as { certificateNumber: string }).certificateNumber,
        verifyCode: (certificate as unknown as { verifyCode: string }).verifyCode,
        attendancePct: certificate.attendancePct, certificateHash: (certificate as unknown as { certificateHash: string }).certificateHash,
      })),
    };
    const dataHash = hashOf(payload);

    // The same facts reviewed twice are the same snapshot, not a second one.
    const existing = await db.query<{ snapshot_id: string; snapshot_version: number }>(
      `SELECT snapshot_id, snapshot_version FROM nzi_console.training_run_snapshots
       WHERE organisation_id=$1 AND course_run_id=$2 AND data_hash=$3`,
      [context.organisationId, record.run.id, dataHash]);
    if (existing.rows[0]) {
      const reusedData: ReviewTrainingRunResult = { courseRunId: record.run.id, snapshotId: existing.rows[0].snapshot_id, dataHash, reused: true, version: record.run.version };
      return {
        data: reusedData,
        entityType: "training_run_snapshot", entityId: existing.rows[0].snapshot_id, topic: "training.run.snapshot_reused",
        after: { dataHash, reused: true },
      };
    }

    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${context.organisationId}:${record.run.id}:training-snapshot`]);
    const next = await db.query<{ next: string }>(
      `SELECT (coalesce(max(snapshot_version),0) + 1)::text AS next FROM nzi_console.training_run_snapshots
       WHERE organisation_id=$1 AND course_run_id=$2`, [context.organisationId, record.run.id]);
    const snapshotId = randomUUID();
    const snapshotVersion = Number(next.rows[0]?.next ?? 1);
    await db.query(
      `INSERT INTO nzi_console.training_run_snapshots
        (organisation_id, snapshot_id, course_run_id, job_id, snapshot_version, run_version, data_hash, payload_json, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [context.organisationId, snapshotId, record.run.id, record.run.jobId, snapshotVersion, record.run.version, dataHash, JSON.stringify(payload), context.actorId]);
    const saved = await db.query<{ version: number }>(
      `UPDATE nzi_console.training_course_runs
       SET review_status='approved', reviewed_version=version, reviewed_by=$3, reviewed_at=now(), version=version+1, updated_at=now(), updated_by=$3
       WHERE organisation_id=$1 AND course_run_id=$2 RETURNING version`,
      [context.organisationId, record.run.id, context.actorId]);

    const data: ReviewTrainingRunResult = { courseRunId: record.run.id, snapshotId, dataHash, reused: false, version: saved.rows[0]!.version };
    return {
      data,
      entityType: "training_run_snapshot", entityId: snapshotId, topic: "training.run.reviewed",
      after: { dataHash, snapshotVersion, register: payload.register.length, certificates: payload.certificates.length },
    };
  });
}

/** Whether this job has any training run at all — the workspace's empty state hangs off it. */
export async function jobHasTrainingRun(db: Queryable, jobId: string): Promise<boolean> {
  const found = await db.query<{ course_run_id: string }>(
    `SELECT course_run_id FROM nzi_console.training_course_runs WHERE job_id=$1 LIMIT 1`, [jobId]);
  return Boolean(found.rows[0]);
}
