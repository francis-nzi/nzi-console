import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  isAllowedTrainingRunStageTransition, trainingCertificateDecision, trainingPlaceGroups,
  trainingRunStages, trainingRunSummary,
} from "@nzi/contracts";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/**
 * The staff Training module. The rules worth holding: the run is the reviewed unit and the
 * person who delivered it does not approve it; certificates are decided by policy, not by
 * whoever holds the capability; a grant's places move as one; and nothing on the screen is
 * a number somebody typed.
 */
describe("training module", () => {
  const workspace = read("apps/console/app/jobs/training/TrainingWorkspace.tsx");
  const runsRoute = read("apps/console/app/api/isolated/training/runs/[courseRunId]/route.ts");
  const bookingsRoute = read("apps/console/app/api/isolated/training/bookings/route.ts");
  const entitlementsRoute = read("apps/console/app/api/isolated/training/entitlements/route.ts");
  const commands = read("packages/contracts/src/commands.ts");
  const jobPage = read("apps/console/app/jobs/[jobId]/page.tsx");

  it("ships behind its own module flag, with FamilyWorkspace still serving when it is off", () => {
    assert.match(read("apps/console/app/lib/jobModuleFlags.ts"), /"job-module-training"/);
    assert.match(jobPage, /family === "training" && jobModuleEnabled\("job-module-training"\)/);
    // The generic workspace is still the fallthrough — the flag off must not mean a blank page.
    assert.match(jobPage, /return <FamilyWorkspace job=\{job\} \/>;/);
  });

  it("gates every mutation on the capability the matrix declares", () => {
    for (const [key, permission] of [
      ["training.booking.create", "training.manage"],
      ["training.attendance.set", "training.manage"],
      ["training.certificate.issue", "training.manage"],
      ["training.run.stage.set", "training.manage"],
      // Reviewing is snapshot.review on purpose: whoever delivered and issued does not
      // also approve. A "training review" capability would have undone that.
      ["training.run.review", "snapshot.review"],
      ["training.entitlement.expiry.set", "training.entitlement.manage"],
    ] as const) {
      assert.match(commands, new RegExp(`"${key}": \\{ key: "${key}"[^}]*permission: "${permission}"`), key);
    }
    for (const key of ["training.run.stage.set", "training.certificate.issue", "training.run.review"]) {
      assert.match(runsRoute, new RegExp(`requireCommandPrincipal\\(request, "${key}"\\)`), key);
    }
    assert.match(bookingsRoute, /requireCommandPrincipal\(request, "training\.booking\.create"\)/);
    assert.match(bookingsRoute, /requireCommandPrincipal\(request, "training\.attendance\.set"\)/);
    assert.match(entitlementsRoute, /requireCommandPrincipal\(request, "training\.entitlement\.expiry\.set"\)/);
    // The screen blocks with a reason up front; the server check stays authoritative.
    for (const capability of ["training.manage", "snapshot.review", "training.entitlement.manage"]) {
      assert.match(workspace, new RegExp(`useEditAccess\\("${capability.replace(".", "\\.")}`), capability);
    }
  });

  it("freezes a reviewed run rather than letting it be edited on", () => {
    assert.match(workspace, /reviewed = run\.reviewStatus === "approved"/);
    // Every mutation on the screen is blocked once the snapshot exists, each saying why.
    const blockedByReview = workspace.match(/blocked=\{reviewed \|\|/g) ?? [];
    assert.ok(blockedByReview.length >= 3, `expected stage, certificates and review to lock; saw ${blockedByReview.length}`);
    assert.match(workspace, /This run is reviewed — its register is frozen\./);
    // Reviewing twice on the same facts reuses the snapshot instead of minting a second.
    assert.match(workspace, /result\.data\.reused/);
  });

  it("moves a grant's places as one, with a reason, and never a used place", () => {
    assert.match(commands, /"training\.entitlement\.expiry\.set"[^}]*reasonRequired: true/);
    assert.match(workspace, /entitlementIds: group\.movableEntitlementIds/);
    assert.match(workspace, /blockedReason=\{reason\.trim\(\) \? undefined : "A reason is required\."\}/);
    const backend = read("packages/isolated-backend/src/trainingRuns.ts");
    assert.match(backend, /ORDER BY entitlement_id FOR UPDATE/, "the rows are locked in a stable order");
    assert.match(backend, /MIXED_GRANT/, "one grant at a time, so the authorized client cannot be swapped");
    assert.match(backend, /default_from_job_end=false/, "a moved date stops being the job-end default");

    const grant = (id: string, over: Record<string, unknown> = {}) => ({
      id, sourceJobId: "job-1", sourceJobNumber: "J000702", courseLabel: "Carbon Literacy",
      status: "available" as const, expiresAt: "2027-03-31", defaultFromJobEnd: true, ...over,
    });
    const [group] = trainingPlaceGroups([grant("e1", { status: "consumed" }), grant("e2"), grant("e3")], "2026-09-13");
    assert.deepEqual(group!.movableEntitlementIds, ["e2", "e3"], "a used place's expiry is not on offer");
  });

  it("keeps a lapsed place in the strip, counted, while available reads zero", () => {
    const lapsed = (id: string, status: "consumed" | "available" = "available") => ({
      id, sourceJobId: "job-1", sourceJobNumber: "J000702", courseLabel: "Carbon Literacy",
      status, expiresAt: "2026-03-31", defaultFromJobEnd: true,
    });
    const [group] = trainingPlaceGroups([lapsed("e1", "consumed"), lapsed("e2"), lapsed("e3")], "2026-09-13");
    assert.equal(group!.summary.available, 0);
    assert.equal(group!.unusedAtExpiry, 2);
    assert.equal(group!.places.length, 3, "nothing is dropped from the strip");
    // The staff wording, distinct from the client portal's benefit-register phrasing.
    assert.match(workspace, /Lapsed · \{group\.unusedAtExpiry\} unused/);
    assert.match(read("packages/ui/src/styles.css"), /\.nz-dot\.lapsed/, "and it is struck and muted, not hidden");
  });

  it("lets policy decide the certificate, not the person clicking issue", () => {
    const sessions = [
      { id: "s1", courseRunId: "r1", sessionTitle: null, sessionDate: "2026-09-01", startTime: null, endTime: null, sessionHours: 3, deliveryMode: null, status: "delivered" as const },
      { id: "s2", courseRunId: "r1", sessionTitle: null, sessionDate: "2026-09-02", startTime: null, endTime: null, sessionHours: 3, deliveryMode: null, status: "delivered" as const },
    ];
    const booking = (id: string, consent: "granted" | "unknown") => ({
      id, courseRunId: "r1", clientId: "c1", participantType: "client_employee" as const, bookingSource: "entitlement" as const,
      personName: id, personEmail: null, billingStatus: "free_place" as const, attendanceStatus: "booked" as const,
      consentStatus: consent, entitlementId: null,
    });
    const attendance = [
      { id: "a1", sessionId: "s1", bookingId: "b1", attendanceStatus: "present" as const, attendanceMinutes: 180, notes: "" },
      { id: "a2", sessionId: "s2", bookingId: "b1", attendanceStatus: "present" as const, attendanceMinutes: 180, notes: "" },
      { id: "a3", sessionId: "s1", bookingId: "b2", attendanceStatus: "present" as const, attendanceMinutes: 180, notes: "" },
      { id: "a4", sessionId: "s2", bookingId: "b2", attendanceStatus: "present" as const, attendanceMinutes: 180, notes: "" },
    ];
    // Consent holds a certificate the person has earned; it does not deny it.
    const held = trainingCertificateDecision({ booking: booking("b2", "unknown"), sessions, attendance, minAttendancePct: 80 });
    assert.equal(held.state, "held");
    assert.equal(held.attendancePct, 100, "they attended in full — the hold is about consent, not attendance");
    const ready = trainingCertificateDecision({ booking: booking("b1", "granted"), sessions, attendance, minAttendancePct: 80 });
    assert.equal(ready.state, "eligible");

    const summary = trainingRunSummary({ bookings: [booking("b1", "granted"), booking("b2", "unknown")], sessions, attendance, certificatesIssued: 0, minAttendancePct: 80, capacity: 20 });
    assert.equal(summary.certificatesReady, 1);
    assert.equal(summary.certificatesHeld, 1);
    // The screen states the threshold rather than leaving "Below threshold" unexplained.
    assert.match(workspace, /a certificate issues at ≥\{minAttendancePct\}% attendance/);
    assert.match(workspace, /Ready — held/);
  });

  it("moves the run one stage at a time, in either direction", () => {
    assert.ok(isAllowedTrainingRunStageTransition("scheduled", "in_delivery"));
    assert.ok(isAllowedTrainingRunStageTransition("in_delivery", "scheduled"), "a stage can be stepped back");
    assert.ok(!isAllowedTrainingRunStageTransition("planned", "delivered"), "no skipping");
    assert.match(workspace, /\[-1, 1\]\.map/, "the screen offers exactly the adjacent stages");
    assert.match(workspace, /fromStage: stage, toStage: target, expectedVersion: run\.version/, "and sends the stage it saw");
    assert.deepEqual([...trainingRunStages], ["planned", "scheduled", "in_delivery", "delivered", "certified", "reviewed"]);
  });

  it("derives every figure on the screen rather than storing it", () => {
    for (const derived of ["trainingRunSummary", "trainingAttendanceForBooking", "trainingCertificateDecision", "trainingPlaceGroups"]) {
      assert.match(workspace, new RegExp(derived), derived);
    }
    // A percentage is computed from the attendance rows; it is never a column to type into.
    assert.match(workspace, /attendancePct \} = trainingAttendanceForBooking/);
  });

  it("reads its data through the tenant guard and the screen-state contract", () => {
    const readRoute = read("apps/console/app/api/isolated/jobs/[jobId]/training-runs/route.ts");
    assert.match(readRoute, /withTenantRead\(pool, organisationId/);
    assert.match(jobPage, /loadScreen<\{runs:TrainingRunRecord\[\]\}>\("training"/);
    // A training job can hold places before anything is scheduled, so zero runs is not
    // "empty" — the module says so in its own words.
    assert.match(read("packages/contracts/src/index.ts"), /training: \{ key: "training"[^}]*isEmpty: \(\) => false/);
    assert.match(workspace, /No course run has been set up for this job yet/);
  });

  it("uses the curated icon set and dd\/mm\/yyyy dates, not emoji or raw ISO", () => {
    assert.match(workspace, /NziIcon/);
    assert.doesNotMatch(workspace, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, "no emoji as iconography");
    assert.match(workspace, /formatDate\(/);
    assert.doesNotMatch(workspace, /toLocaleDateString\("en-GB", \{ (?!month)/);
  });
});
