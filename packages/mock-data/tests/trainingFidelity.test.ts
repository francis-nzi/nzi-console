import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isAllowedEntitlementTransition,
  trainingAttendanceForBooking,
  trainingCertificateEligible,
} from "@nzi/contracts";
import {
  bushyTailsTrainingEntitlements,
  carbonLiteracyAttendance,
  carbonLiteracyBookings,
  carbonLiteracyCertificates,
  carbonLiteracyProduct,
  carbonLiteracyRun,
  carbonLiteracySessions,
  trainingFidelityScheduledMinutes,
} from "../src/trainingFidelity";

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("Training model fidelity", () => {
  it("survives a JSON round-trip as the contract types", () => {
    assert.deepEqual(roundTrip(carbonLiteracyRun), carbonLiteracyRun);
    assert.deepEqual(roundTrip(carbonLiteracyBookings), carbonLiteracyBookings);
    assert.deepEqual(roundTrip(bushyTailsTrainingEntitlements), bushyTailsTrainingEntitlements);
  });

  it("fixture 1 — a CRP free place runs available → reserved → consumed, one expires, one stays open", () => {
    const bySource = bushyTailsTrainingEntitlements.filter((e) => e.sourceJobNumber === "J000712");
    assert.equal(bySource.length, 3);

    const consumed = bySource.find((e) => e.status === "consumed")!;
    assert.equal(consumed.allocatedToBookingId, "bk-priya");
    assert.ok(consumed.reservedAt && consumed.consumedAt, "consumed keeps both timestamps");
    // the booking that consumed it is entitlement-funded and not billed
    const priya = carbonLiteracyBookings.find((b) => b.id === "bk-priya")!;
    assert.equal(priya.entitlementId, consumed.id);
    assert.equal(priya.billingStatus, "free_place");
    assert.equal(priya.bookingSource, "entitlement");

    const expired = bySource.find((e) => e.status === "expired")!;
    assert.equal(expired.allocatedToBookingId, null);
    assert.ok(new Date(expired.expiresAt!) < new Date("2026-09-01"));

    assert.ok(bySource.some((e) => e.status === "available"));
  });

  it("only legal entitlement transitions are permitted", () => {
    assert.ok(isAllowedEntitlementTransition("available", "reserved"));
    assert.ok(isAllowedEntitlementTransition("reserved", "consumed"));
    assert.ok(isAllowedEntitlementTransition("reserved", "available")); // booking cancelled
    assert.ok(!isAllowedEntitlementTransition("consumed", "reserved"));
    assert.ok(!isAllowedEntitlementTransition("available", "consumed"));
    assert.ok(!isAllowedEntitlementTransition("expired", "available"));
  });

  it("fixture 2 — 2-of-3 attendance is below the 80% policy → no certificate", () => {
    const dana = trainingAttendanceForBooking("bk-dana", carbonLiteracySessions, carbonLiteracyAttendance);
    assert.equal(dana.scheduledMinutes, trainingFidelityScheduledMinutes);
    assert.equal(dana.attendedMinutes, 240);
    assert.equal(dana.attendancePct, 66.7);
    assert.ok(!trainingCertificateEligible(dana.attendancePct, carbonLiteracyProduct.certificateMinAttendancePct));
    assert.ok(!carbonLiteracyCertificates.some((c) => c.bookingId === "bk-dana"));

    const priya = trainingAttendanceForBooking("bk-priya", carbonLiteracySessions, carbonLiteracyAttendance);
    assert.equal(priya.attendancePct, 100);
    assert.ok(trainingCertificateEligible(priya.attendancePct, carbonLiteracyProduct.certificateMinAttendancePct));
  });

  it("fixture 3 — the run mixes online and in-person sessions", () => {
    const modes = new Set(carbonLiteracySessions.map((s) => s.deliveryMode));
    assert.ok(modes.has("online") && modes.has("in_person"));
    assert.equal(carbonLiteracyRun.deliveryMode, "hybrid");
    assert.ok(carbonLiteracyRun.onlineMeetingUrl && carbonLiteracyRun.venueAddress);
  });

  it("fixture 4 — bookings past capacity are waitlisted, not confirmed", () => {
    const confirmed = carbonLiteracyBookings.filter((b) => b.attendanceStatus !== "waitlisted" && b.attendanceStatus !== "cancelled");
    const waitlisted = carbonLiteracyBookings.filter((b) => b.attendanceStatus === "waitlisted");
    assert.equal(carbonLiteracyRun.capacity, 12);
    assert.equal(confirmed.length, 12);
    assert.equal(waitlisted.length, 2);
  });

  it("fixture 5 — billing and attendance can diverge (invoiced no-show)", () => {
    const tom = carbonLiteracyBookings.find((b) => b.id === "bk-tom")!;
    assert.equal(tom.billingStatus, "invoiced");
    assert.equal(tom.attendanceStatus, "no_show");
    const tomAttendance = trainingAttendanceForBooking("bk-tom", carbonLiteracySessions, carbonLiteracyAttendance);
    assert.equal(tomAttendance.attendedMinutes, 0);
  });

  it("the training run's job is independent of the free-place CRP client (NZC-024)", () => {
    // run job 716 is not the CRP job 712; the only link is the entitlement row
    assert.notEqual(carbonLiteracyRun.jobId, "712");
    const priya = carbonLiteracyBookings.find((b) => b.id === "bk-priya")!;
    assert.equal(priya.clientId, "bushy-tails");
    assert.equal(bushyTailsTrainingEntitlements.find((e) => e.id === priya.entitlementId)!.sourceClientId, "bushy-tails");
  });
});
