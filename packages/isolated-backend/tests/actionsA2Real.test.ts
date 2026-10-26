import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import {
  commandGrantForRole, strategyIsReportable,
  type CommandContext, type LibraryStrategy, type StaffRole,
} from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { withTenantRead } from "../src/postgres";
import { getPortalClientStrategies } from "../src/portalStrategies";
import { addPortalStrategy, proposePortalStrategy, updatePortalStrategy } from "../src/portalStrategyCommands";
import { listClientStrategies, listLibraryStrategies, updateClientStrategy } from "../src/reductionStrategies";
import { approveClientProposal, declineClientProposal, promoteClientProposal } from "../src/strategyProposals";
import { getClientWorkspace } from "../src/readModels";

/**
 * Actions A2 against a real database (0188 on A1's 0186): the client's hand in their own plan, from the portal, with
 * staff keeping the gate.
 *
 * - add from the library → `origin: plan`, Proposed, aligned to the library default, shown to the client;
 * - propose a custom action → a pending `client_proposal`: off the plan, unaligned, not reportable, "with your adviser";
 * - staff approve (→ Agreed, aligned) or decline with a reason (→ Declined, the client sees why) — decided once;
 * - an approved proposal promoted into the library under `admin.lookups`, once, with its alignment as the default;
 * - any client user nominates an owner from their own contacts (another client's refused, by the command and the key);
 * - only the owner moves the date, progress and status, along the owner's half of the ladder;
 * - no delete; own client only; no staff identity; everything audited.
 */

const ORG = "a2-org";
const A = "client-a";
const B = "client-b";
const ADA = "portal-ada"; // Client A, and Client A's contact con-ada by address
const ZED = "portal-zed"; // Client A, not a contact
const BOB = "portal-bob"; // Client B
let keys = 0;
const staff = (role: StaffRole = "admin", reason?: string): CommandContext => {
  keys += 1;
  return { organisationId: ORG, actorId: "staff-sam", principal: "staff", idempotencyKey: `a2-${keys}`, correlationId: `corr-a2-${keys}`,
    grant: commandGrantForRole(role, ORG, "staff-sam"), ...(reason ? { reason } : {}) };
};
const portal = (portalUserId: string, clientId: string): CommandContext => {
  keys += 1;
  return { organisationId: ORG, actorId: portalUserId, principal: "portal", portal: { portalUserId, clientId }, idempotencyKey: `a2p-${keys}`, correlationId: `corr-a2p-${keys}` };
};
const refused = (code: string) => (error: Error & { issues?: Array<{ code: string }> }) => error.issues?.some((issue) => issue.code === code) === true;
const unauthorised = (error: Error) => error.name === "AuthorizationError";

describe("Actions A2 — the client's hand in their plan, and staff's gate (0188), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let admin: pg.Client;
  let library: LibraryStrategy[] = [];
  let requirementId = "";
  const q = async <T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []) => (await admin.query<T>(sql, params)).rows;
  const read = <T>(work: Parameters<typeof withTenantRead<T>>[2]) => withTenantRead(database.pool, ORG, work);
  const action = async (id: string, clientId = A) => (await read((db) => listClientStrategies(db, clientId))).find((entry) => entry.id === id)!;
  const portalView = (clientId: string, portalUserId: string | null) => read((db) => getPortalClientStrategies(db, {
    clientId, today: "2026-10-26", participation: true, viewer: portalUserId ? { organisationId: ORG, portalUserId } : null }));

  before(async () => {
    database = (await createDisposableDatabase("actionsa2"))!;
    admin = await database.admin();
    await q(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, 'A2 Org')`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'staff-sam', 'admin', 'active', 'Sam Staffer')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, $2, 'Client A', 'active'), ($1, $3, 'Client B', 'active')`, [ORG, A, B]);
    await q(`INSERT INTO nzi_console.client_contacts (organisation_id, contact_id, client_id, full_name, email, status, created_by, updated_by) VALUES
      ($1, 'con-ada', $2, 'Ada Client', 'Ada@ClientA.example', 'active', 'seed', 'seed'),
      ($1, 'con-cy', $2, 'Cy Client', 'cy@clienta.example', 'active', 'seed', 'seed'),
      ($1, 'con-bob', $3, 'Bob Other', 'bob@clientb.example', 'active', 'seed', 'seed')`, [ORG, A, B]);
    await q(`INSERT INTO nzi_console.portal_users (organisation_id, portal_user_id, client_id, email_normalized, display_name, status) VALUES
      ($1, $2, $4, 'ada@clienta.example', 'Ada', 'active'),
      ($1, $3, $4, 'zed@clienta.example', 'Zed', 'active'),
      ($1, $5, $6, 'bob@clientb.example', 'Bob', 'active')`, [ORG, ADA, ZED, A, BOB, B]);
    library = await read((db) => listLibraryStrategies(db));
    requirementId = (await q<{ requirement_id: string }>(`SELECT r.requirement_id FROM nzi_console.srs_requirements r JOIN nzi_console.srs_frameworks f USING (organisation_id, framework_id) WHERE f.status = 'active' AND r.active LIMIT 1`))[0]!.requirement_id;
  });
  after(async () => { await admin?.end(); await database?.end(); });

  let added = "", proposed = "", toDecline = "";

  describe("from the portal (R1, R2)", () => {
    it("adds a library action to the client's own plan — origin plan, Proposed, aligned to the library default, shown to them", async () => {
      const entry = library.find((strategy) => strategy.active && strategy.defaultSrsRequirementIds.length > 0)!;
      assert.ok(entry, "the organisation's library is provisioned");
      added = (await addPortalStrategy(database.pool, { clientId: A, strategyId: entry.id }, portal(ADA, A))).data.clientStrategyId;
      const row = await action(added);
      assert.deepEqual([row.origin, row.status, row.includeInReport, row.proposal, row.strategyId], ["plan", "proposed", true, null, entry.id]);
      assert.deepEqual([...row.srsRequirementIds].sort(), [...new Set(entry.defaultSrsRequirementIds)].sort());
      await assert.rejects(addPortalStrategy(database.pool, { clientId: A, strategyId: entry.id }, portal(ADA, A)), refused("ALREADY_ON_PLAN"));
      const view = await portalView(A, ADA);
      assert.ok(view.plan.flatMap((group) => group.strategies).some((strategy) => strategy.id === added && strategy.statusLabel === "Proposed"));
      assert.ok(!view.participation!.library.some((option) => option.id === entry.id), "no longer offered once held");
    });

    it("proposes a custom action: pending, off the plan, unaligned and not reportable — 'with your adviser'", async () => {
      proposed = (await proposePortalStrategy(database.pool, { clientId: A, title: "Electric delivery vans", scope: "1", note: "Lease ends in March." }, portal(ADA, A))).data.clientStrategyId;
      toDecline = (await proposePortalStrategy(database.pool, { clientId: A, title: "Plant a forest", scope: "3" }, portal(ZED, A))).data.clientStrategyId;
      const row = await action(proposed);
      assert.deepEqual([row.origin, row.status, row.proposal?.state, row.proposal?.note, row.srsRequirementIds.length], ["client_proposal", "proposed", "pending", "Lease ends in March.", 0]);
      assert.equal(strategyIsReportable(row), false);
      const workspace = await read((db) => getClientWorkspace(db, A));
      assert.ok(!workspace!.strategies.plan.some((strategy) => strategy.id === proposed), "not on the CRM plan");
      assert.ok(workspace!.strategies.proposals.some((strategy) => strategy.id === proposed), "in the proposals queue");
      const view = await portalView(A, ADA);
      assert.ok(!view.plan.flatMap((group) => group.strategies).some((strategy) => strategy.id === proposed), "not on the client's plan");
      assert.deepEqual(view.participation!.proposals.find((entry) => entry.id === proposed)?.state, "pending");
    });

    it("holds the client to their own plan: another client's user is refused, and a removed or held-back action reads as absent", async () => {
      await assert.rejects(proposePortalStrategy(database.pool, { clientId: A, title: "Sneaky", scope: "1" }, portal(BOB, B)), unauthorised);
      await assert.rejects(updatePortalStrategy(database.pool, { clientStrategyId: added, expectedVersion: (await action(added)).version, ownerContactId: "con-bob" }, portal(BOB, B)), unauthorised);
      await q(`UPDATE nzi_console.portal_users SET status = 'disabled' WHERE portal_user_id = $1`, [ZED]);
      await assert.rejects(proposePortalStrategy(database.pool, { clientId: A, title: "While disabled", scope: "1" }, portal(ZED, A)), unauthorised);
      await q(`UPDATE nzi_console.portal_users SET status = 'active' WHERE portal_user_id = $1`, [ZED]);
      // A staff command is never a portal user's.
      await assert.rejects(declineClientProposal(database.pool, { clientStrategyId: proposed, expectedVersion: 1, reason: "self-serve" }, { ...portal(ADA, A), reason: "self-serve" }), unauthorised);
    });

    it("refuses what is staff's to set — alignment, inclusion, notes — by name", async () => {
      await assert.rejects(updatePortalStrategy(database.pool, { clientStrategyId: added, expectedVersion: (await action(added)).version, includeInReport: false } as never, portal(ADA, A)), refused("STAFF_ONLY_FIELD"));
      await assert.rejects(updatePortalStrategy(database.pool, { clientStrategyId: added, expectedVersion: (await action(added)).version, srsRequirementIds: [] } as never, portal(ADA, A)), refused("STAFF_ONLY_FIELD"));
    });
  });

  describe("staff decide, once (R2, R3)", () => {
    it("approves: aligned, Agreed, on the plan and reportable — and cannot be decided again", async () => {
      const before = await action(proposed);
      await assert.rejects(approveClientProposal(database.pool, { clientStrategyId: proposed, expectedVersion: before.version, title: "Electric vans", scope: "1", controlLevel: "direct_control",
        srsRequirementIds: [], includeInReport: true }, staff()), refused("REQUIRED"));
      await approveClientProposal(database.pool, { clientStrategyId: proposed, expectedVersion: before.version, title: "Electric delivery vans (fleet of 6)", scope: "1",
        controlLevel: "direct_control", category: "Fleet", srsRequirementIds: [requirementId], includeInReport: true, ownerContactId: "con-ada", targetDate: "2027-03-31" }, staff());
      const row = await action(proposed);
      assert.deepEqual([row.status, row.proposal?.state, row.title, row.ownerContactId, row.targetDate, row.srsRequirementIds], ["agreed", "approved", "Electric delivery vans (fleet of 6)", "con-ada", "2027-03-31", [requirementId]]);
      assert.equal(strategyIsReportable(row), true);
      assert.equal(row.origin, "client_proposal", "its origin stays what it was");
      await assert.rejects(declineClientProposal(database.pool, { clientStrategyId: proposed, expectedVersion: row.version, reason: "changed mind" }, staff("admin", "changed mind")), refused("ALREADY_DECIDED"));
      await assert.rejects(q(`UPDATE nzi_console.client_strategies SET proposal_state = 'declined', proposal_decision_reason = 'x', status = 'declined' WHERE client_strategy_id = $1`, [proposed]), /decided once/);
      const view = await portalView(A, ADA);
      assert.ok(view.plan.flatMap((group) => group.strategies).some((strategy) => strategy.id === proposed && strategy.status === "agreed"), "now on the client's plan");
    });

    it("declines with the reason the client reads — off the plan, out of their list, and not editable onto the plan", async () => {
      const before = await action(toDecline);
      await assert.rejects(declineClientProposal(database.pool, { clientStrategyId: toDecline, expectedVersion: before.version, reason: "" }, staff()), refused("REQUIRED"));
      await declineClientProposal(database.pool, { clientStrategyId: toDecline, expectedVersion: before.version, reason: "Offsetting is outside the plan; we will cover it in the review." },
        staff("admin", "Offsetting is outside the plan; we will cover it in the review."));
      const row = await action(toDecline);
      assert.deepEqual([row.status, row.proposal?.state, row.proposal?.decisionReason], ["declined", "declined", "Offsetting is outside the plan; we will cover it in the review."]);
      const view = await portalView(A, ZED);
      assert.ok(!view.plan.flatMap((group) => group.strategies).some((strategy) => strategy.id === toDecline), "not on the plan list");
      const shown = view.participation!.proposals.find((entry) => entry.id === toDecline)!;
      assert.deepEqual([shown.state, shown.reason], ["declined", "Offsetting is outside the plan; we will cover it in the review."]);
      await assert.rejects(updateClientStrategy(database.pool, { clientStrategyId: toDecline, expectedVersion: row.version, status: "proposed", progressPct: 0,
        srsRequirementIds: [requirementId], includeInReport: true }, staff()), refused("PROPOSAL_UNDECIDED"));
      await assert.rejects(q(`UPDATE nzi_console.client_strategies SET status = 'proposed' WHERE client_strategy_id = $1`, [toDecline]), /client_strategies_proposal_ladder/);
    });

    it("promotes an approved proposal into the library under admin.lookups, once, with its alignment as the default", async () => {
      await assert.rejects(promoteClientProposal(database.pool, { clientStrategyId: proposed, key: "electric-vans", leverIds: [] }, staff("consultant")), unauthorised);
      await assert.rejects(promoteClientProposal(database.pool, { clientStrategyId: toDecline, key: "forest", leverIds: [] }, staff()), refused("NOT_PROMOTABLE"));
      const promoted = await promoteClientProposal(database.pool, { clientStrategyId: proposed, key: "Electric-Vans", leverIds: [], description: "Replace the delivery fleet with EVs." }, staff());
      const entry = (await read((db) => listLibraryStrategies(db))).find((strategy) => strategy.id === promoted.data.strategyId)!;
      assert.deepEqual([entry.key, entry.title, entry.scope, entry.defaultSrsRequirementIds], ["electric-vans", "Electric delivery vans (fleet of 6)", "1", [requirementId]]);
      assert.deepEqual(await q(`SELECT promoted_from_client_strategy_id FROM nzi_console.reduction_strategies WHERE strategy_id = $1`, [entry.id]), [{ promoted_from_client_strategy_id: proposed }]);
      await assert.rejects(promoteClientProposal(database.pool, { clientStrategyId: proposed, key: "electric-vans-2", leverIds: [] }, staff()), refused("ALREADY_PROMOTED"));
      assert.equal((await action(proposed)).strategyId, null, "the client's own action stays bespoke");
    });
  });

  describe("owners and the owner's moves (R4, R5)", () => {
    it("lets any client user nominate an owner from their own contacts — another client's contact is refused by the command and the key", async () => {
      await updatePortalStrategy(database.pool, { clientStrategyId: added, expectedVersion: (await action(added)).version, ownerContactId: "con-cy" }, portal(ZED, A));
      assert.equal((await action(added)).ownerContactId, "con-cy");
      await assert.rejects(updatePortalStrategy(database.pool, { clientStrategyId: added, expectedVersion: (await action(added)).version, ownerContactId: "con-bob" }, portal(ZED, A)), refused("NOT_A_CONTACT"));
      await assert.rejects(q(`UPDATE nzi_console.client_strategies SET owner_contact_id = 'con-bob' WHERE client_strategy_id = $1`, [added]), /client_strategies_owner_contact_fk/);
    });

    it("lets only the owner move the date, progress and status — and only along the owner's half of the ladder", async () => {
      // Ada owns the approved van action (con-ada matches her address, case aside); Zed does not.
      await assert.rejects(updatePortalStrategy(database.pool, { clientStrategyId: proposed, expectedVersion: (await action(proposed)).version, progressPct: 10 }, portal(ZED, A)), refused("NOT_THE_OWNER"));
      await updatePortalStrategy(database.pool, { clientStrategyId: proposed, expectedVersion: (await action(proposed)).version, status: "in_progress", progressPct: 30, targetDate: "2027-04-30" }, portal(ADA, A));
      assert.deepEqual(await action(proposed).then((row) => [row.status, row.progressPct, row.targetDate]), ["in_progress", 30, "2027-04-30"]);
      await assert.rejects(updatePortalStrategy(database.pool, { clientStrategyId: proposed, expectedVersion: (await action(proposed)).version, status: "declined" }, portal(ADA, A)), refused("ILLEGAL_TRANSITION"));
      await assert.rejects(updatePortalStrategy(database.pool, { clientStrategyId: proposed, expectedVersion: (await action(proposed)).version, status: "agreed" }, portal(ADA, A)), refused("ILLEGAL_TRANSITION"));
      await updatePortalStrategy(database.pool, { clientStrategyId: proposed, expectedVersion: (await action(proposed)).version, progressPct: 100 }, portal(ADA, A));
      assert.deepEqual(await action(proposed).then((row) => [row.status, row.progressPct]), ["complete", 100], "100% completes it");
      // A proposed action the client added cannot be self-agreed, even by its owner.
      await updatePortalStrategy(database.pool, { clientStrategyId: added, expectedVersion: (await action(added)).version, ownerContactId: "con-ada" }, portal(ADA, A));
      await assert.rejects(updatePortalStrategy(database.pool, { clientStrategyId: added, expectedVersion: (await action(added)).version, status: "in_progress" }, portal(ADA, A)), refused("ILLEGAL_TRANSITION"));
      const view = await portalView(A, ADA);
      const mine = view.plan.flatMap((group) => group.strategies).find((strategy) => strategy.id === added)!;
      assert.deepEqual([mine.yours, mine.nextStatuses], [true, ["proposed"]], "the page offers only where it stands");
    });
  });

  describe("the record", () => {
    it("audits every client and staff act, as the principal that made it", async () => {
      const rows = await q<{ action: string; principal_type: string }>(
        `SELECT action, principal_type FROM nzi_console.audit_events WHERE organisation_id = $1 AND entity_type IN ('client_strategy', 'reduction_strategy') ORDER BY occurred_at`, [ORG]);
      const seen = new Set(rows.map((row) => `${row.principal_type}:${row.action}`));
      for (const expected of ["portal:portal_strategy_added", "portal:portal_strategy_proposed", "portal:portal_strategy_updated",
        "staff:client_strategy_proposal_approved", "staff:client_strategy_proposal_declined", "staff:reduction_strategy_promoted"]) {
        assert.ok(seen.has(expected), expected);
      }
    });

    it("shows the client no staff identity and no money", async () => {
      const payload = JSON.stringify(await portalView(A, ADA));
      assert.doesNotMatch(payload, /staff-sam|Sam Staffer/, "never who decided");
      assert.doesNotMatch(payload, /tco2e|estimate|£/i, "figures only — no money, no estimate");
    });

    it("leaves the plan as it was for the staff preview — shown, and owning nothing", async () => {
      const preview = await portalView(A, null);
      assert.ok(preview.plan.flatMap((group) => group.strategies).every((strategy) => !strategy.yours && strategy.nextStatuses.length === 0));
    });
  });
});
