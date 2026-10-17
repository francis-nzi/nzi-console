import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { roleCapabilityGrants, type StaffRole } from "@nzi/contracts";
import type { StaffMe } from "../app/lib/useEditAccess";
import { isSelfApproved, readIndependentApprovalRequired, snapshotActAccess } from "../app/jobs/snapshotApproval";

// RULING-NZC022-relax-self-approval: the job's approve / validate / publish controls follow the server's NZC-022 setting
// through the same maySelfApprove the commands call.
const me = (role: StaffRole, userId = "francis"): StaffMe => ({ userId, organisationId: "org-a", role, matrixVersion: 10, capabilities: roleCapabilityGrants(role) });
const frozenBy = (createdBy: string) => ({ createdBy });

describe("snapshot approval access on the job", () => {
  it("flag true (default): the preparer is refused approve and release, exactly as before; a non-preparer proceeds", () => {
    assert.deepEqual(snapshotActAccess(me("admin"), frozenBy("francis"), "snapshot.review", true), { state: "denied", reason: "You prepared this snapshot, so another person must approve it." });
    assert.deepEqual(snapshotActAccess(me("admin"), frozenBy("francis"), "report.publish", true), { state: "denied", reason: "You prepared this snapshot, so another person must validate and publish it." });
    assert.deepEqual(snapshotActAccess(me("reviewer", "rita"), frozenBy("francis"), "snapshot.review", true), { state: "allowed" });
    assert.deepEqual(snapshotActAccess(me("admin", "ada"), frozenBy("francis"), "report.publish", true), { state: "allowed" });
  });

  it("flag false: an Admin preparer may approve, validate and publish their own snapshot", () => {
    assert.deepEqual(snapshotActAccess(me("admin"), frozenBy("francis"), "snapshot.review", false), { state: "allowed" });
    assert.deepEqual(snapshotActAccess(me("admin"), frozenBy("francis"), "report.publish", false), { state: "allowed" });
  });

  it("flag false: a preparer without the self-approval capability is still refused", () => {
    const consultant = me("consultant");
    assert.equal(snapshotActAccess(consultant, frozenBy("francis"), "snapshot.review", false).state, "denied");
    // Holding the approve capability is not enough — self-approval rides report.publish.
    const approverOnly: StaffMe = { ...me("reviewer"), capabilities: [{ capability: "snapshot.review", scope: "all" }] };
    assert.deepEqual(snapshotActAccess(approverOnly, frozenBy("francis"), "snapshot.review", false), { state: "denied", reason: "You prepared this snapshot, so another person must approve it." });
  });

  it("a role without the command's own capability is refused whatever the flag", () => {
    assert.equal(snapshotActAccess(me("consultant", "carol"), frozenBy("francis"), "snapshot.review", false).state, "denied");
    assert.equal(snapshotActAccess(me("viewer", "vic"), frozenBy("francis"), "report.publish", false).state, "denied");
  });

  it("is never allowed before the viewer is known", () => {
    assert.equal(snapshotActAccess(undefined, frozenBy("francis"), "snapshot.review", false).state, "checking");
    assert.equal(snapshotActAccess("signed-out", frozenBy("francis"), "snapshot.review", false).state, "denied");
    assert.equal(snapshotActAccess(null, frozenBy("francis"), "snapshot.review", false).state, "unavailable");
  });

  it("reads the flag fail-closed and recognises a self-approval", () => {
    assert.equal(readIndependentApprovalRequired({ independentApprovalRequired: false }), false);
    for (const body of [{ independentApprovalRequired: true }, { independentApprovalRequired: "false" }, {}, null, undefined]) assert.equal(readIndependentApprovalRequired(body), true);
    assert.equal(isSelfApproved({ createdBy: "francis", approvedBy: "francis" }), true);
    assert.equal(isSelfApproved({ createdBy: "francis", approvedBy: "rita" }), false);
    assert.equal(isSelfApproved({ createdBy: "francis", approvedBy: null }), false);
  });
});

describe("the job's Data assurance carries the Approve reviewed snapshot control", () => {
  const stage = readFileSync(new URL("../app/jobs/CrpAssuranceStage.tsx", import.meta.url), "utf8");
  it("renders it after sign-off, drives report.snapshot.approve, and gates it on the shared rule", () => {
    assert.match(stage, /<SignOffPanel[^\n]*\/>\s*<SnapshotApprovalPanel jobId=\{jobId\} readKey=\{data\} onApproved=\{onReload\} \/>/);
    assert.match(stage, /\/api\/isolated\/reviewed-snapshots\/\$\{encodeURIComponent\(snapshot\.id\)\}\/approve/);
    assert.match(stage, /snapshotActAccess\(me, snapshot, "snapshot\.review", independentRequired\)/);
    assert.match(stage, /access\.state === "allowed"\s*\? <div[\s\S]*?Approve reviewed snapshot/);
    assert.match(stage, /isSelfApproved\(snapshot\) \? " · self-approved"/);
  });
  it("reads the server's setting with the snapshots", () => {
    const route = readFileSync(new URL("../app/api/isolated/jobs/[jobId]/reviewed-snapshots/route.ts", import.meta.url), "utf8");
    assert.match(route, /independentApprovalRequired:independentApprovalRequired\(\)/);
  });
});
