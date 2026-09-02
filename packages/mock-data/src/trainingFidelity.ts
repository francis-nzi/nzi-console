// Worst-case Training fixtures proving the Phase 0 model (0048/0049) represents
// real delivery intricacies: CRP-funded free places through their whole
// lifecycle, sub-threshold attendance that earns no certificate, mixed
// online/in-person runs, over-capacity waitlists, and billing that diverges
// from attendance. Typed against @nzi/contracts; see
// docs/MODEL_FIDELITY_JOB_FAMILIES.md §3 / §5.
// Illustrative demonstrator data only — no real client data, no PII.
import type {
  TrainingBooking,
  TrainingCertificate,
  TrainingCourseRun,
  TrainingCourseSession,
  TrainingEntitlement,
  TrainingProduct,
  TrainingRunView,
  TrainingSessionAttendance,
} from "@nzi/contracts";

const ORG = "demo-nzi-console";
const RUN_ID = "run-carbon-literacy-2026q3";

export const carbonLiteracyProduct: TrainingProduct = {
  id: "tp-carbon-literacy",
  organisationId: ORG,
  productCode: "CL-01",
  productName: "Carbon Literacy for Operations Teams",
  description: "One-day certified Carbon Literacy course, delivered online or in person.",
  defaultHours: 6,
  defaultDeliveryMode: "hybrid",
  defaultCapacity: 12,
  defaultMinAttendees: 4,
  certificatePolicy: "Certificate issued at ≥ 80% of scheduled contact time.",
  certificateMinAttendancePct: 80,
  isActive: true,
};

// Mixed-mode run: 2 online sessions + 1 in-person (fixture 3). Capacity 12 (fixture 4).
export const carbonLiteracyRun: TrainingCourseRun = {
  id: RUN_ID,
  jobId: "716", // a training job owned by "Verdant Foods" — NOT the CRP client below
  trainingProductId: carbonLiteracyProduct.id,
  runName: "Carbon Literacy — 2026 Q3 open cohort",
  courseCode: "CL-01/2026Q3",
  totalHours: 6,
  deliveryMode: "hybrid",
  capacity: 12,
  minAttendees: 4,
  status: "delivering",
  workflowStageKey: "attendance",
  startDate: "2026-09-08",
  endDate: "2026-09-22",
  venueName: "Leeds Climate Hub",
  venueAddress: "3 Wellington Place, Leeds LS1 4AP",
  onlineMeetingUrl: "https://meet.example.org/cl-2026q3",
  notes: "Session 3 is in person; sessions 1–2 online.",
  version: 4,
  reviewStatus: "pending",
  reviewedVersion: null,
};

export const carbonLiteracySessions: TrainingCourseSession[] = [
  {
    id: `${RUN_ID}-s1`, courseRunId: RUN_ID, sessionTitle: "Foundations", sessionDate: "2026-09-08",
    startTime: "09:30", endTime: "11:30", sessionHours: 2, deliveryMode: "online", status: "delivered",
  },
  {
    id: `${RUN_ID}-s2`, courseRunId: RUN_ID, sessionTitle: "Measuring & reporting", sessionDate: "2026-09-15",
    startTime: "09:30", endTime: "11:30", sessionHours: 2, deliveryMode: "online", status: "delivered",
  },
  {
    id: `${RUN_ID}-s3`, courseRunId: RUN_ID, sessionTitle: "Action planning (in person)", sessionDate: "2026-09-22",
    startTime: "10:00", endTime: "12:00", sessionHours: 2, deliveryMode: "in_person", status: "delivered",
  },
];

const SCHEDULED_MINUTES = carbonLiteracySessions.reduce((sum, s) => sum + Math.round((s.sessionHours ?? 0) * 60), 0); // 360

const booking = (over: Partial<TrainingBooking> & Pick<TrainingBooking, "id" | "personName">): TrainingBooking => ({
  courseRunId: RUN_ID,
  clientId: null,
  participantType: "external_individual",
  bookingSource: "manual",
  personEmail: null,
  billingStatus: "paid",
  attendanceStatus: "attended",
  consentStatus: "granted",
  entitlementId: null,
  ...over,
});

// Fixture 1 — a free place from a CRP job, consumed by a client employee.
const priya = booking({
  id: "bk-priya", personName: "Priya (Bushy Tails Ltd)", participantType: "client_employee",
  clientId: "bushy-tails", bookingSource: "entitlement", billingStatus: "free_place",
  entitlementId: "ent-btl-quote-1", attendanceStatus: "attended",
});
// Fixture 5 — invoiced but never showed up.
const tom = booking({
  id: "bk-tom", personName: "Tom Reeve", billingStatus: "invoiced", attendanceStatus: "no_show",
});
// Fixture 2 — attends 2 of 3 sessions (240/360 = 66.7%) → below the 80% policy.
const dana = booking({
  id: "bk-dana", personName: "Dana Okoro", billingStatus: "paid", attendanceStatus: "partial",
});
// Fill the room to capacity (12 confirmed).
const filler = Array.from({ length: 9 }, (_, i) =>
  booking({
    id: `bk-f${i + 1}`, personName: `Attendee ${i + 1}`,
    billingStatus: i % 2 === 0 ? "paid" : "invoiced", attendanceStatus: "attended",
  }),
);
// Fixture 4 — two more bookings beyond capacity 12 → waitlisted.
const waitlist = [
  booking({ id: "bk-wait1", personName: "Waitlist A", attendanceStatus: "waitlisted" }),
  booking({ id: "bk-wait2", personName: "Waitlist B", attendanceStatus: "waitlisted" }),
];

export const carbonLiteracyBookings: TrainingBooking[] = [priya, tom, dana, ...filler, ...waitlist];

const confirmedFullAttendance = [priya, ...filler]; // present in every session

export const carbonLiteracyAttendance: TrainingSessionAttendance[] = carbonLiteracySessions.flatMap((session) => {
  const rows: TrainingSessionAttendance[] = [];
  for (const b of confirmedFullAttendance) {
    rows.push({
      id: `att-${b.id}-${session.id}`, sessionId: session.id, bookingId: b.id,
      attendanceStatus: "present", attendanceMinutes: Math.round((session.sessionHours ?? 0) * 60),
    });
  }
  // Tom: absent everywhere.
  rows.push({
    id: `att-${tom.id}-${session.id}`, sessionId: session.id, bookingId: tom.id,
    attendanceStatus: "absent", attendanceMinutes: 0,
  });
  // Dana: present for sessions 1 & 2, absent for the in-person session 3.
  const danaPresent = session.id !== `${RUN_ID}-s3`;
  rows.push({
    id: `att-${dana.id}-${session.id}`, sessionId: session.id, bookingId: dana.id,
    attendanceStatus: danaPresent ? "present" : "absent",
    attendanceMinutes: danaPresent ? Math.round((session.sessionHours ?? 0) * 60) : 0,
  });
  return rows;
});

// Fixture 1 — three entitlements from CRP job J000712: one consumed, one expired
// unused, one still available (a manual grant).
export const bushyTailsTrainingEntitlements: TrainingEntitlement[] = [
  {
    id: "ent-btl-quote-1", sourceJobId: "712", sourceJobNumber: "J000712", sourceClientId: "bushy-tails",
    entitlementType: "free_place", origin: "quote", status: "consumed",
    allocatedToBookingId: "bk-priya", allocatedCourseRunId: RUN_ID,
    reservedAt: "2026-08-20T10:00:00Z", consumedAt: "2026-09-22T12:30:00Z", expiresAt: "2027-03-31T00:00:00Z",
  },
  {
    id: "ent-btl-quote-2", sourceJobId: "712", sourceJobNumber: "J000712", sourceClientId: "bushy-tails",
    entitlementType: "free_place", origin: "quote", status: "expired",
    allocatedToBookingId: null, allocatedCourseRunId: null,
    reservedAt: null, consumedAt: null, expiresAt: "2026-06-30T00:00:00Z",
  },
  {
    id: "ent-btl-grant-3", sourceJobId: "712", sourceJobNumber: "J000712", sourceClientId: "bushy-tails",
    entitlementType: "free_place", origin: "manual_grant", status: "available",
    allocatedToBookingId: null, allocatedCourseRunId: null,
    reservedAt: null, consumedAt: null, expiresAt: "2027-03-31T00:00:00Z",
  },
];

// Only the fully-attended free-place participant has a certificate so far.
// Dana is deliberately absent from this list (fixture 2 — no certificate).
export const carbonLiteracyCertificates: TrainingCertificate[] = [
  {
    id: "cert-priya", courseRunId: RUN_ID, bookingId: "bk-priya",
    certificateNumber: "CL-01-2026Q3-0001", status: "issued", version: 1, supersedesCertificateId: null,
    attendedMinutes: SCHEDULED_MINUTES, requiredMinutes: Math.ceil(SCHEDULED_MINUTES * 0.8),
    attendancePct: 100,
    certificateHash: "sha256:7d1a9c0b5e2f4a8d6c3b1e0f9a8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9",
  },
];

export const carbonLiteracyRunView: TrainingRunView = {
  run: carbonLiteracyRun,
  product: carbonLiteracyProduct,
  sessions: carbonLiteracySessions,
  bookings: carbonLiteracyBookings,
  attendance: carbonLiteracyAttendance,
  entitlements: bushyTailsTrainingEntitlements,
  certificates: carbonLiteracyCertificates,
};

export const trainingFidelityScheduledMinutes = SCHEDULED_MINUTES;
