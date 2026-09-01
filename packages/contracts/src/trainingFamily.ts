// Training job-family model — Phase 0 contract types (NZC-055/056).
// Mirrors migrations 0048_training_core + 0049_training_entitlements. No runtime
// yet; the training module reads these once it is built. See
// docs/MODEL_FIDELITY_JOB_FAMILIES.md §3 / §5.

export type TrainingDeliveryMode = "in_person" | "online" | "hybrid";

export type TrainingRunStatus =
  | "draft"
  | "scheduled"
  | "delivering"
  | "complete"
  | "cancelled";

export type TrainingRunStageKey =
  | "setup"
  | "bookings"
  | "delivery"
  | "attendance"
  | "certificates"
  | "complete";

export type TrainingReviewStatus = "pending" | "approved" | "rejected";

export type TrainingParticipantType =
  | "external_individual"
  | "client_employee"
  | "internal"
  | "partner";

export type TrainingBookingSource = "manual" | "portal" | "entitlement" | "import";

export type TrainingBillingStatus =
  | "pending"
  | "invoiced"
  | "paid"
  | "free_place"
  | "waived";

export type TrainingBookingAttendanceStatus =
  | "booked"
  | "waitlisted"
  | "attended"
  | "partial"
  | "no_show"
  | "cancelled";

export type TrainingConsentStatus = "unknown" | "granted" | "declined";

export type TrainingSessionStatus = "scheduled" | "delivered" | "cancelled";

export type TrainingSessionAttendanceStatus =
  | "booked"
  | "present"
  | "absent"
  | "excused";

export type TrainingEntitlementStatus =
  | "available"
  | "reserved"
  | "consumed"
  | "expired"
  | "revoked";

export type TrainingEntitlementOrigin = "quote" | "manual_grant";

export type TrainingCertificateStatus = "issued" | "revoked" | "superseded";

export type TrainingProduct = {
  id: string;
  organisationId: string;
  productCode: string | null;
  productName: string;
  description: string;
  defaultHours: number | null;
  defaultDeliveryMode: TrainingDeliveryMode | null;
  defaultCapacity: number | null;
  defaultMinAttendees: number | null;
  certificatePolicy: string;
  certificateMinAttendancePct: number;
  isActive: boolean;
};

export type TrainingCourseRun = {
  id: string;
  jobId: string;
  trainingProductId: string | null;
  runName: string | null;
  courseCode: string | null;
  totalHours: number | null;
  deliveryMode: TrainingDeliveryMode;
  capacity: number | null;
  minAttendees: number | null;
  status: TrainingRunStatus;
  workflowStageKey: TrainingRunStageKey;
  startDate: string | null;
  endDate: string | null;
  venueName: string | null;
  venueAddress: string | null;
  onlineMeetingUrl: string | null;
  notes: string;
  version: number;
  reviewStatus: TrainingReviewStatus;
  reviewedVersion: number | null;
};

export type TrainingCourseSession = {
  id: string;
  courseRunId: string;
  sessionTitle: string | null;
  sessionDate: string | null;
  startTime: string | null;
  endTime: string | null;
  sessionHours: number | null;
  deliveryMode: TrainingDeliveryMode | null;
  status: TrainingSessionStatus;
};

export type TrainingBooking = {
  id: string;
  courseRunId: string;
  clientId: string | null;
  participantType: TrainingParticipantType;
  bookingSource: TrainingBookingSource;
  personName: string;
  personEmail: string | null;
  billingStatus: TrainingBillingStatus;
  attendanceStatus: TrainingBookingAttendanceStatus;
  consentStatus: TrainingConsentStatus;
  entitlementId: string | null;
};

export type TrainingSessionAttendance = {
  id: string;
  sessionId: string;
  bookingId: string;
  attendanceStatus: TrainingSessionAttendanceStatus;
  attendanceMinutes: number | null;
};

export type TrainingEntitlement = {
  id: string;
  sourceJobId: string;
  sourceJobNumber: string;
  sourceClientId: string;
  entitlementType: "free_place";
  origin: TrainingEntitlementOrigin;
  status: TrainingEntitlementStatus;
  allocatedToBookingId: string | null;
  allocatedCourseRunId: string | null;
  reservedAt: string | null;
  consumedAt: string | null;
  expiresAt: string | null;
};

export type TrainingCertificate = {
  id: string;
  courseRunId: string;
  bookingId: string;
  certificateNumber: string;
  status: TrainingCertificateStatus;
  version: number;
  supersedesCertificateId: string | null;
  attendedMinutes: number;
  requiredMinutes: number;
  attendancePct: number;
  certificateHash: string;
};

// The run header + its detail grids, as the training module will assemble it.
export type TrainingRunView = {
  run: TrainingCourseRun;
  product: TrainingProduct | null;
  sessions: TrainingCourseSession[];
  bookings: TrainingBooking[];
  attendance: TrainingSessionAttendance[];
  entitlements: TrainingEntitlement[];
  certificates: TrainingCertificate[];
};

/**
 * Summed attended minutes for a booking across a run's sessions, and whether
 * that clears the product's certificate policy. Pure — mirrors the policy check
 * the certificate-issue command runs server-side.
 */
export function trainingAttendanceForBooking(
  bookingId: string,
  sessions: TrainingCourseSession[],
  attendance: TrainingSessionAttendance[],
): { attendedMinutes: number; scheduledMinutes: number; attendancePct: number } {
  const sessionMinutes = new Map(
    sessions.map((s) => [s.id, Math.round((s.sessionHours ?? 0) * 60)]),
  );
  const scheduledMinutes = [...sessionMinutes.values()].reduce((a, b) => a + b, 0);
  let attendedMinutes = 0;
  for (const record of attendance) {
    if (record.bookingId !== bookingId) continue;
    if (record.attendanceStatus === "present") {
      attendedMinutes += record.attendanceMinutes ?? sessionMinutes.get(record.sessionId) ?? 0;
    } else if (record.attendanceStatus === "excused") {
      // excused sessions do not count against the participant
      attendedMinutes += sessionMinutes.get(record.sessionId) ?? 0;
    }
  }
  const attendancePct =
    scheduledMinutes === 0 ? 0 : Math.round((attendedMinutes / scheduledMinutes) * 1000) / 10;
  return { attendedMinutes, scheduledMinutes, attendancePct };
}

export function trainingCertificateEligible(
  attendancePct: number,
  minAttendancePct: number,
): boolean {
  return attendancePct >= minAttendancePct;
}

/** Legal available → reserved → consumed transitions; anything else is rejected. */
export function isAllowedEntitlementTransition(
  from: TrainingEntitlementStatus,
  to: TrainingEntitlementStatus,
): boolean {
  const allowed: Record<TrainingEntitlementStatus, TrainingEntitlementStatus[]> = {
    available: ["reserved", "expired", "revoked"],
    reserved: ["consumed", "available", "revoked"], // release back to available on booking cancel
    consumed: [],
    expired: [],
    revoked: [],
  };
  return allowed[from].includes(to);
}
