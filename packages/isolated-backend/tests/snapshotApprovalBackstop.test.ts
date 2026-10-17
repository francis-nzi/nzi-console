import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandGrantForRole } from "@nzi/contracts";
import { approveReviewedCrpSnapshot, SeparationOfDutiesError } from "../src/index";
import { isCheckViolation } from "../src/errors";

/**
 * FINDING-self-approval-db-constraint: when the database's separation-of-duties CHECK refused an approval, the person saw "The
 * command could not be completed." A refusal by either 0168 constraint now surfaces as the separation-of-duties refusal it is; any
 * other database error is passed on unchanged. (Real Postgres raises these in selfApprovalReal; here the UPDATE is made to.)
 */
function poolWhoseApprovalThrows(error: unknown) {
  const client = {
    async query(sql: string) {
      if (sql.includes("/* nzi:access */")) return { rows: [{ client_id: "client-a", owner_user_id: null }] };
      if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: [] };
      if (sql.includes("FROM nzi_console.reviewed_crp_snapshots WHERE")) return { rows: [{ job_id: "job-a", created_by: "francis", approved_by: null }] };
      if (sql.includes("UPDATE nzi_console.reviewed_crp_snapshots SET approved_by")) throw error;
      return { rows: [] };
    },
    release() {},
  };
  return { connect: async () => client } as never;
}
const context = { organisationId: "org-a", actorId: "francis", principal: "staff" as const, grant: commandGrantForRole("admin", "org-a", "francis"), idempotencyKey: "k", correlationId: "c" };
const check = (constraint: string) => Object.assign(new Error(`violates check constraint "${constraint}"`), { code: "23514", constraint });

describe("the snapshot approval's database backstop", () => {
  it("recognises a CHECK refusal by its constraint's name only", () => {
    assert.equal(isCheckViolation(check("reviewed_crp_snapshots_independent_approval"), "reviewed_crp_snapshots_independent_approval"), true);
    assert.equal(isCheckViolation(check("some_other_check"), "reviewed_crp_snapshots_independent_approval"), false);
    assert.equal(isCheckViolation(Object.assign(new Error("dup"), { code: "23505", constraint: "reviewed_crp_snapshots_independent_approval" }), "reviewed_crp_snapshots_independent_approval"), false);
    assert.equal(isCheckViolation(null, "x"), false);
  });

  for (const constraint of ["reviewed_crp_snapshots_independent_approval", "reviewed_crp_snapshots_self_approval_is_preparer"]) {
    it(`turns a ${constraint} refusal into the separation-of-duties refusal, not a generic failure`, async () => {
      const before = process.env.REPORT_REQUIRE_INDEPENDENT_APPROVAL;
      process.env.REPORT_REQUIRE_INDEPENDENT_APPROVAL = "false"; // the command lets the preparer through; the database is what refuses
      try {
        await assert.rejects(approveReviewedCrpSnapshot(poolWhoseApprovalThrows(check(constraint)), { reviewedSnapshotId: "snap-a" }, context),
          (error: unknown) => error instanceof SeparationOfDutiesError && error.permission === "snapshot.review" && /someone else must approve it/.test(error.message));
      } finally {
        if (before === undefined) delete process.env.REPORT_REQUIRE_INDEPENDENT_APPROVAL; else process.env.REPORT_REQUIRE_INDEPENDENT_APPROVAL = before;
      }
    });
  }

  it("passes any other database error on unchanged", async () => {
    const other = Object.assign(new Error("connection reset"), { code: "08006" });
    await assert.rejects(approveReviewedCrpSnapshot(poolWhoseApprovalThrows(other), { reviewedSnapshotId: "snap-a" }, { ...context, actorId: "rev", grant: commandGrantForRole("reviewer", "org-a", "rev") }),
      (error: unknown) => error === other);
  });
});
