import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandGrantForRole, type StaffRole } from "@nzi/contracts";
import { capabilityScope, ownerFilterFor } from "../src/access";

/**
 * What changes for the creator when they assign a client to somebody else (NZC-090).
 *
 * Since the create form began writing `owner_user_id`, choosing an owner has a consequence beyond
 * the label on the record: that column is what `own_clients` resolves against. This file states
 * exactly which capabilities follow the owner and which do not, because "you lose access" turns
 * out to be too coarse a description to act on — and a governance consequence that is only
 * approximately understood is one nobody can consent to.
 *
 * **Viewing does not follow the owner.** No role holds `client.view` at `own_clients`; every role
 * that can see clients can see all of them. A consultant who creates a client and assigns it to a
 * colleague keeps seeing it, keeps editing it, keeps managing its jobs and strategies.
 *
 * **Three capabilities do follow it**, all on the consultant role: re-baselining, portal
 * administration, and reading that client's audit trail. Those are the powers that move.
 */

const grant = (role: StaffRole) => commandGrantForRole(role, "org", "someone");

describe("assigning a client to someone else", () => {
  it("does not take the client out of the creator's sight", () => {
    // The thing most likely to be assumed, and not true: client.view is organisation-wide for
    // every role that holds it.
    for (const role of ["admin", "consultant", "reviewer", "finance", "viewer"] as StaffRole[]) {
      const scope = capabilityScope(grant(role), "client.view");
      if (scope === null) continue;
      assert.equal(scope, "all", `${role} can see every client, owned or not`);
    }
  });

  it("moves exactly three capabilities with the owner, and names them", () => {
    const consultant = grant("consultant");
    const follows = (["baseline.rebaseline", "portal.admin", "audit.view"] as const)
      .filter((capability) => capabilityScope(consultant, capability) === "own_clients");
    assert.deepEqual(follows, ["baseline.rebaseline", "portal.admin", "audit.view"]);
  });

  it("leaves the consultant's day-to-day work untouched", () => {
    // Editing the record, running its jobs, its strategies and its SRS assessment are all
    // organisation-wide, so handing a client to a colleague does not strand the work in progress.
    const consultant = grant("consultant");
    for (const capability of ["client.edit", "job.manage", "strategy.manage", "srs.manage", "report.edit"] as const) {
      assert.equal(capabilityScope(consultant, capability), "all", `${capability} does not follow the owner`);
    }
  });

  it("filters an own_clients read to the holder, which is the mechanism", () => {
    // `ownerFilterFor` returns the user to filter by under an own_clients grant, and null when the
    // grant is organisation-wide — so the filter is applied only where the scope says to.
    const consultant = grant("consultant");
    assert.equal(ownerFilterFor(consultant, "audit.view"), "someone");
    assert.equal(ownerFilterFor(consultant, "client.view"), null);
  });

  it("is only reachable deliberately — an admin holds everything at `all`", () => {
    // Which is why this is a consultant's question and not everyone's.
    const admin = grant("admin");
    for (const capability of ["baseline.rebaseline", "portal.admin", "audit.view"] as const) {
      assert.equal(capabilityScope(admin, capability), "all");
    }
  });
});
