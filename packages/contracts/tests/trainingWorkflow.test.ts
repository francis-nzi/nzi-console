import test from "node:test";
import assert from "node:assert/strict";
import {
  isAllowedTrainingRunStageTransition, trainingCertificateDecision, trainingPlaceExpiry,
  trainingPlaceGroups, trainingPlaceState, trainingPlacesSummary, trainingRunStages, trainingRunSummary,
} from "../src/trainingWorkflow";
import type { TrainingBooking, TrainingCourseSession, TrainingEntitlement, TrainingSessionAttendance } from "../src/trainingFamily";

/**
 * The training rules every surface shares. Staff, the employer and the trainee each word
 * these differently, so if the arithmetic lived in three places they would eventually
 * quote three different numbers.
 */

const TODAY = "2026-09-13";

const session = (id: string, hours: number): TrainingCourseSession => ({
  id, courseRunId: "run-1", sessionTitle: `Session ${id}`, sessionDate: "2026-03-03",
  startTime: "09:00", endTime: "12:00", sessionHours: hours, deliveryMode: "in_person",
  venueName: "NZI Studio", venueAddress: "", onlineMeetingUrl: null, onlinePasscode: null,
  status: "delivered", notes: "",
} as TrainingCourseSession);

const booking = (id: string, over: Partial<TrainingBooking> = {}): TrainingBooking => ({
  id, courseRunId: "run-1", clientId: "client-a", participantType: "client_employee",
  bookingSource: "manual", personName: `Person ${id}`, personEmail: `${id}@example.test`,
  billingStatus: "pending", attendanceStatus: "booked", consentStatus: "granted",
  entitlementId: null, ...over,
});

const attended = (bookingId: string, sessionId: string, minutes: number): TrainingSessionAttendance => ({
  id: `${bookingId}-${sessionId}`, sessionId, bookingId, attendanceStatus: "present", attendanceMinutes: minutes, notes: "",
} as TrainingSessionAttendance);

const place = (over: Partial<TrainingEntitlement> & { defaultFromJobEnd?: boolean } = {}) => ({
  status: "available" as TrainingEntitlement["status"], expiresAt: null as string | null, ...over,
});

test("the run's stage machine moves one step at a time, in either direction", () => {
  assert.deepEqual([...trainingRunStages], ["planned", "scheduled", "in_delivery", "delivered", "certified", "reviewed"]);
  assert.ok(isAllowedTrainingRunStageTransition("planned", "scheduled"));
  assert.ok(isAllowedTrainingRunStageTransition("certified", "delivered"), "a step back is allowed, as elsewhere on the spine");
  assert.ok(!isAllowedTrainingRunStageTransition("planned", "certified"), "no skipping");
  assert.ok(!isAllowedTrainingRunStageTransition("reviewed", "archived"), "unknown stages are refused");
});

test("a certificate issues on the policy, and consent holds it rather than failing it", () => {
  const sessions = [session("s1", 3), session("s2", 3)];
  const full = [attended("b1", "s1", 180), attended("b1", "s2", 180)];
  const eligible = trainingCertificateDecision({ booking: booking("b1"), sessions, attendance: full, minAttendancePct: 80 });
  assert.equal(eligible.state, "eligible");
  assert.equal(eligible.attendancePct, 100);

  // Attended in full, but consent is not recorded: the certificate is theirs the moment it is.
  const held = trainingCertificateDecision({
    booking: booking("b1", { consentStatus: "unknown" }), sessions, attendance: full, minAttendancePct: 80,
  });
  assert.equal(held.state, "held");
  assert.match(held.reason, /consent/i);

  // Half the course is a decision, not a hold, and it says the number.
  const short = trainingCertificateDecision({
    booking: booking("b2"), sessions, attendance: [attended("b2", "s1", 180)], minAttendancePct: 80,
  });
  assert.equal(short.state, "not-eligible");
  assert.equal(short.attendancePct, 50);
  assert.match(short.reason, /below the 80%/);

  const cancelled = trainingCertificateDecision({
    booking: booking("b3", { attendanceStatus: "cancelled" }), sessions, attendance: [], minAttendancePct: 80,
  });
  assert.equal(cancelled.state, "not-eligible");
  assert.match(cancelled.reason, /cancelled/);
});

test("expiry distinguishes a chosen date from the granting job's default", () => {
  const fromJob = trainingPlaceExpiry(place({ expiresAt: "2027-03-31", defaultFromJobEnd: true }), TODAY);
  assert.equal(fromJob.state, "active");
  if (fromJob.state === "active") assert.equal(fromJob.fromJobEnd, true, "the client portal can say it was not deliberately set");

  const moved = trainingPlaceExpiry(place({ expiresAt: "2027-03-31", defaultFromJobEnd: false }), TODAY);
  if (moved.state === "active") assert.equal(moved.fromJobEnd, false);

  // A place with no date never expires, and must not be treated as lapsed.
  assert.equal(trainingPlaceExpiry(place(), TODAY).state, "none");
});

test("a place approaching expiry warns, and a passed date lapses rather than vanishing", () => {
  const soon = trainingPlaceExpiry(place({ expiresAt: "2026-10-15" }), TODAY);
  assert.equal(soon.state, "expiring");
  if (soon.state === "expiring") assert.equal(soon.daysRemaining, 32);

  const past = trainingPlaceExpiry(place({ expiresAt: "2026-03-31" }), TODAY);
  assert.equal(past.state, "lapsed");
  // An available place whose date has gone reads as lapsed, not as available.
  assert.equal(trainingPlaceState(place({ expiresAt: "2026-03-31" }), TODAY), "lapsed");
  assert.equal(trainingPlaceState(place({ expiresAt: "2027-03-31" }), TODAY), "available");
  // A consumed place stays consumed whatever the date says — the training happened.
  assert.equal(trainingPlaceState(place({ status: "consumed", expiresAt: "2026-03-31" }), TODAY), "consumed");
});

test("the places summary counts each place once, and never double-counts a lapse", () => {
  const summary = trainingPlacesSummary([
    place({ status: "consumed" }),
    place({ status: "consumed" }),
    place({ status: "reserved", expiresAt: "2027-03-31" }),
    place({ expiresAt: "2027-03-31" }),
    place({ expiresAt: "2026-10-15" }),
    place({ expiresAt: "2026-03-31" }),
    place({ status: "revoked" }),
  ], TODAY);
  assert.equal(summary.granted, 7);
  assert.equal(summary.consumed, 2);
  assert.equal(summary.reserved, 1);
  assert.equal(summary.available, 2, "the lapsed one is not available");
  assert.equal(summary.lapsed, 1);
  assert.equal(summary.revoked, 1);
  assert.equal(summary.consumed + summary.reserved + summary.available + summary.lapsed + summary.revoked, summary.granted);
  // Only unused places can expire, and the soonest of them is what to act on.
  assert.equal(summary.expiringSoon, 1);
  assert.equal(summary.nextExpiry, "2026-10-15");
});

test("a lapsed grant keeps its unused places visible and reads zero available", () => {
  // The rule both registers render: unused places stay in the strip, counted, while
  // "available" reads 0 — shown, never silently dropped or quietly zeroed.
  const grant = (over: Partial<TrainingEntitlement> = {}) => ({
    sourceJobId: "job-crp-1", sourceJobNumber: "J000702", courseLabel: "Carbon Literacy — Level 1",
    status: "available" as TrainingEntitlement["status"], expiresAt: "2026-03-31", defaultFromJobEnd: true, ...over,
  });
  const [group] = trainingPlaceGroups([
    grant({ status: "consumed" }), grant({ status: "consumed" }), grant({ status: "consumed" }),
    grant(), grant(),
  ], TODAY);

  assert.equal(group!.summary.granted, 5);
  assert.equal(group!.summary.consumed, 3);
  assert.equal(group!.summary.available, 0, "nothing is available once the date has passed");
  assert.equal(group!.unusedAtExpiry, 2, "and the two that went unused are still counted");
  assert.equal(group!.places.length, 5, "every place stays in the strip");
  assert.deepEqual(group!.places, ["consumed", "consumed", "consumed", "lapsed", "lapsed"]);
  assert.equal(group!.expiry.state, "lapsed");
  if (group!.expiry.state === "lapsed") assert.equal(group!.expiry.fromJobEnd, true);
});

test("grants are grouped per granting job and course, each with its own expiry", () => {
  const groups = trainingPlaceGroups([
    { sourceJobId: "job-1", sourceJobNumber: "J000702", courseLabel: "Carbon Literacy", status: "consumed", expiresAt: "2027-03-31" },
    { sourceJobId: "job-1", sourceJobNumber: "J000702", courseLabel: "Carbon Literacy", status: "available", expiresAt: "2027-03-31" },
    { sourceJobId: "job-1", sourceJobNumber: "J000702", courseLabel: "Awareness webinar", status: "available", expiresAt: "2026-09-30" },
  ], TODAY);
  assert.equal(groups.length, 2, "two courses from one job are two grants");
  const webinar = groups.find((group) => group.courseLabel === "Awareness webinar")!;
  assert.equal(webinar.summary.available, 1);
  assert.equal(webinar.expiry.state, "expiring", "its own date, not the other grant's");
});

test("the run summary counts the booked, not the cancelled or the waitlisted", () => {
  const sessions = [session("s1", 3), session("s2", 3)];
  const bookings = [
    booking("b1", { entitlementId: "ent-1" }),
    booking("b2"),
    booking("b3", { consentStatus: "unknown" }),
    booking("b4", { attendanceStatus: "cancelled" }),
    booking("b5", { attendanceStatus: "waitlisted" }),
  ];
  const attendance = [
    attended("b1", "s1", 180), attended("b1", "s2", 180),
    attended("b2", "s1", 180),
    attended("b3", "s1", 180), attended("b3", "s2", 180),
  ];
  const summary = trainingRunSummary({ bookings, sessions, attendance, certificatesIssued: 1, minAttendancePct: 80, capacity: 20 });
  assert.equal(summary.booked, 3, "cancelled and waitlisted are not booked places");
  assert.equal(summary.waitlisted, 1);
  assert.equal(summary.entitlementFunded, 1);
  // b1 and b3 are at 100%; b1's certificate is already issued, b3 is held on consent.
  assert.equal(summary.certificatesReady, 0);
  assert.equal(summary.certificatesHeld, 1);
  assert.equal(summary.attendancePct, 83.3);
});

test("a run with nobody booked reports no attendance rather than zero percent", () => {
  const summary = trainingRunSummary({ bookings: [], sessions: [session("s1", 3)], attendance: [], certificatesIssued: 0, minAttendancePct: 80, capacity: 12 });
  assert.equal(summary.booked, 0);
  assert.equal(summary.attendancePct, null, "no one attending is not the same as everyone missing");
});
