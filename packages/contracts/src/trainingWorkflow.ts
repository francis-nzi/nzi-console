import { trainingAttendanceForBooking, trainingCertificateEligible, type TrainingBooking, type TrainingCourseSession, type TrainingEntitlement, type TrainingSessionAttendance } from "./trainingFamily";

/**
 * Training workflow — the run's stage machine, the certificate policy, and the places
 * arithmetic every surface reads.
 *
 * Three audiences look at this data: staff delivering the run, the client who paid for the
 * places, and the person who did the training. They must never disagree, so the rules live
 * here once and each surface renders them in its own words.
 */

/* ── The run's stage machine ─────────────────────────────────────────────────────────── */

/**
 * The run is the versioned, reviewed unit. Its stages are its own — a job is the
 * engagement, a run is one delivery of a course, and conflating them is how you end up
 * with a "certified" job that has three runs at different points.
 */
export const trainingRunStages = ["planned", "scheduled", "in_delivery", "delivered", "certified", "reviewed"] as const;
export type TrainingRunStage = (typeof trainingRunStages)[number];

export const trainingRunStageLabels: Record<TrainingRunStage, string> = {
  planned: "Planned", scheduled: "Scheduled", in_delivery: "In delivery",
  delivered: "Delivered", certified: "Certified", reviewed: "Reviewed",
};

/** Adjacent-only in both directions, like every other stage machine on the spine. */
export function isAllowedTrainingRunStageTransition(from: string, to: string): boolean {
  const fromIndex = (trainingRunStages as readonly string[]).indexOf(from);
  const toIndex = (trainingRunStages as readonly string[]).indexOf(to);
  return fromIndex >= 0 && toIndex >= 0 && Math.abs(toIndex - fromIndex) === 1;
}

/* ── Certificates ───────────────────────────────────────────────────────────────────── */

export type TrainingCertificateDecision =
  | { state: "eligible"; attendancePct: number }
  | { state: "held"; reason: string; attendancePct: number }
  | { state: "not-eligible"; reason: string; attendancePct: number };

/**
 * Whether this booking earns a certificate, and if not, why — the register shows the
 * reason rather than a silent blank.
 *
 * Consent is a hold, not a failure: the person attended, and the certificate is theirs as
 * soon as consent is recorded. Attendance below the policy is a decision, not a hold.
 */
export function trainingCertificateDecision(input: {
  booking: Pick<TrainingBooking, "id" | "consentStatus" | "attendanceStatus">;
  sessions: readonly TrainingCourseSession[];
  attendance: readonly TrainingSessionAttendance[];
  minAttendancePct: number;
}): TrainingCertificateDecision {
  const { attendancePct } = trainingAttendanceForBooking(input.booking.id, input.sessions, input.attendance);
  if (input.booking.attendanceStatus === "cancelled") {
    return { state: "not-eligible", reason: "The booking was cancelled.", attendancePct };
  }
  if (!trainingCertificateEligible(attendancePct, input.minAttendancePct)) {
    return { state: "not-eligible", reason: `Attendance is ${attendancePct}%, below the ${input.minAttendancePct}% the policy requires.`, attendancePct };
  }
  if (input.booking.consentStatus !== "granted") {
    return { state: "held", reason: "Held until the trainee's consent is recorded.", attendancePct };
  }
  return { state: "eligible", attendancePct };
}

/* ── Places ─────────────────────────────────────────────────────────────────────────── */

export type TrainingPlaceState = "consumed" | "reserved" | "available" | "lapsed" | "revoked";

/**
 * Expiry, resolved rather than inferred. `default_from_job_end` is carried through because
 * "expires 31 Mar 2026" reads differently depending on whether someone chose that date or
 * it simply came from the granting job.
 */
export type TrainingPlaceExpiry =
  | { state: "none" }
  | { state: "active"; expiresAt: string; daysRemaining: number; fromJobEnd: boolean }
  | { state: "expiring"; expiresAt: string; daysRemaining: number; fromJobEnd: boolean }
  | { state: "lapsed"; expiresAt: string; fromJobEnd: boolean };

/** The client portal's warning window: close enough to act on, far enough to be useful. */
export const trainingExpiryWarningDays = 60;

export function trainingPlaceExpiry(entitlement: Pick<TrainingEntitlement, "expiresAt"> & { defaultFromJobEnd?: boolean }, today: string): TrainingPlaceExpiry {
  const expiresAt = entitlement.expiresAt;
  if (!expiresAt) return { state: "none" };
  const fromJobEnd = entitlement.defaultFromJobEnd ?? false;
  const days = daysBetween(today, expiresAt);
  if (days < 0) return { state: "lapsed", expiresAt, fromJobEnd };
  if (days <= trainingExpiryWarningDays) return { state: "expiring", expiresAt, daysRemaining: days, fromJobEnd };
  return { state: "active", expiresAt, daysRemaining: days, fromJobEnd };
}

const daysBetween = (from: string, to: string) => {
  const start = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.round((end - start) / 86400000) : 0;
};

/** One place, as both sides of the platform see it. */
export function trainingPlaceState(entitlement: Pick<TrainingEntitlement, "status" | "expiresAt"> & { defaultFromJobEnd?: boolean }, today: string): TrainingPlaceState {
  if (entitlement.status === "revoked") return "revoked";
  if (entitlement.status === "consumed") return "consumed";
  if (entitlement.status === "reserved") return "reserved";
  // An available place whose date has passed is lapsed — shown, never silently dropped.
  if (entitlement.status === "expired") return "lapsed";
  return trainingPlaceExpiry(entitlement, today).state === "lapsed" ? "lapsed" : "available";
}

export type TrainingPlacesSummary = {
  granted: number;
  consumed: number;
  reserved: number;
  /** What the client can still use — the commercial number. */
  available: number;
  lapsed: number;
  revoked: number;
  /** Places whose expiry falls inside the warning window and are still unused. */
  expiringSoon: number;
  nextExpiry: string | null;
};

/**
 * The places a client holds, counted once. Every surface renders this differently —
 * staff say "remaining", the client portal says "yet to be taken" — but the arithmetic is
 * the same, so the two can never quote different numbers.
 */
export function trainingPlacesSummary(entitlements: ReadonlyArray<Pick<TrainingEntitlement, "status" | "expiresAt"> & { defaultFromJobEnd?: boolean }>, today: string): TrainingPlacesSummary {
  const summary: TrainingPlacesSummary = {
    granted: 0, consumed: 0, reserved: 0, available: 0, lapsed: 0, revoked: 0, expiringSoon: 0, nextExpiry: null,
  };
  for (const entitlement of entitlements) {
    summary.granted += 1;
    const state = trainingPlaceState(entitlement, today);
    if (state === "consumed") summary.consumed += 1;
    else if (state === "reserved") summary.reserved += 1;
    else if (state === "lapsed") summary.lapsed += 1;
    else if (state === "revoked") summary.revoked += 1;
    else summary.available += 1;

    if (state === "available") {
      const expiry = trainingPlaceExpiry(entitlement, today);
      if (expiry.state === "expiring") summary.expiringSoon += 1;
      if (expiry.state === "expiring" || expiry.state === "active") {
        summary.nextExpiry = summary.nextExpiry === null || expiry.expiresAt < summary.nextExpiry ? expiry.expiresAt : summary.nextExpiry;
      }
    }
  }
  return summary;
}

/* ── What a run is worth saying about itself ─────────────────────────────────────────── */

export type TrainingRunSummary = {
  booked: number;
  capacity: number | null;
  waitlisted: number;
  entitlementFunded: number;
  certificatesIssued: number;
  certificatesReady: number;
  certificatesHeld: number;
  /** Mean attendance across bookings that are not cancelled; null when nobody is booked. */
  attendancePct: number | null;
};

export function trainingRunSummary(input: {
  bookings: readonly TrainingBooking[];
  sessions: readonly TrainingCourseSession[];
  attendance: readonly TrainingSessionAttendance[];
  certificatesIssued: number;
  minAttendancePct: number;
  capacity: number | null;
}): TrainingRunSummary {
  const live = input.bookings.filter((booking) => booking.attendanceStatus !== "cancelled");
  const counted = live.filter((booking) => booking.attendanceStatus !== "waitlisted");
  let attendanceTotal = 0, ready = 0, held = 0;
  for (const booking of counted) {
    const decision = trainingCertificateDecision({ booking, sessions: input.sessions, attendance: input.attendance, minAttendancePct: input.minAttendancePct });
    attendanceTotal += decision.attendancePct;
    if (decision.state === "eligible") ready += 1;
    if (decision.state === "held") held += 1;
  }
  return {
    booked: counted.length,
    capacity: input.capacity,
    waitlisted: live.filter((booking) => booking.attendanceStatus === "waitlisted").length,
    entitlementFunded: counted.filter((booking) => booking.entitlementId !== null && booking.entitlementId !== undefined).length,
    certificatesIssued: input.certificatesIssued,
    certificatesReady: Math.max(0, ready - input.certificatesIssued),
    certificatesHeld: held,
    attendancePct: counted.length === 0 ? null : Math.round((attendanceTotal / counted.length) * 10) / 10,
  };
}
