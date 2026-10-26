import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, composeReportPlan, strategyIsReportable, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { VersionConflictError } from "../src/errors";
import { withTenantRead } from "../src/postgres";
import {
  assignClientStrategy, deactivateLever, deactivateLibraryStrategy, listClientStrategies, listLevers, listLibraryStrategies,
  updateClientStrategy, upsertLever, upsertLibraryStrategy,
} from "../src/reductionStrategies";

/**
 * Actions A1 against a real database (0186): the library admin-managed and versioned (levers and their allocation
 * included), the plan's status ladder, an owner who is one of the client's contacts — held by the database through the
 * client — where an action came from (plan or an SRS gap, set once), and Include-in-report plus Agreed-or-beyond
 * deciding what a report composes while the plan read shows everything. A legacy `planned` row, written before 0186,
 * proves the data migration.
 */

const ORG = "actions-org";
const CLIENT = "client-a";
const OTHER = "client-b";
let keys = 0;
const context = (role: StaffRole = "admin", reason?: string): CommandContext => {
  keys += 1;
  return { organisationId: ORG, actorId: "ada", principal: "staff", idempotencyKey: `a1-${keys}`, correlationId: `corr-a1-${keys}`,
    grant: commandGrantForRole(role, ORG, "ada"), ...(reason ? { reason } : {}) };
};
const refused = (code: string) => (error: Error & { issues?: Array<{ code: string }> }) => error.issues?.some((issue) => issue.code === code) === true;

describe("Actions A1 — the library, the plan and the ladder (0186), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let admin: pg.Client;
  let requirementId = "";
  const q = async <T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []) => (await admin.query<T>(sql, params)).rows;
  const plan = () => withTenantRead(database.pool, ORG, (db) => listClientStrategies(db, CLIENT));
  const one = async (id: string) => (await plan()).find((strategy) => strategy.id === id)!;
  const update = async (id: string, changes: Partial<{ status: string; progressPct: number; ownerContactId: string | null; includeInReport: boolean }>) => {
    const current = await one(id);
    return updateClientStrategy(database.pool, {
      clientStrategyId: id, expectedVersion: current.version, status: changes.status ?? current.status, progressPct: changes.progressPct ?? current.progressPct,
      ...(changes.ownerContactId !== undefined ? { ownerContactId: changes.ownerContactId } : {}), targetDate: current.targetDate, notes: current.notes,
      srsRequirementIds: current.srsRequirementIds, includeInReport: changes.includeInReport ?? current.includeInReport,
    }, context());
  };

  before(async () => {
    database = (await createDisposableDatabase("actionsa1", {
      // The plan as it stood before 0186: a planned action with a free-text owner, and one in progress.
      onMigration: async (filename, client) => {
        if (!filename.startsWith("0183_")) return;
        await client.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, 'Actions Org')`, [ORG]);
        await client.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
        await client.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, $2, 'Client A', 'active'), ($1, $3, 'Client B', 'active')`, [ORG, CLIENT, OTHER]);
        const requirement = (await client.query<{ requirement_id: string; framework_id: string }>(`SELECT requirement_id, framework_id FROM nzi_console.srs_requirements LIMIT 1`)).rows[0]!;
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO nzi_console.client_strategies (organisation_id, client_strategy_id, client_id, bespoke_title, bespoke_scope, bespoke_control_level, status, owner, created_by)
           VALUES ($1, 'legacy-planned', $2, 'Legacy LED retrofit', '2', 'direct_control', 'planned', 'Facilities team', 'v7'),
                  ($1, 'legacy-live', $2, 'Legacy fleet review', '1', 'direct_control', 'in_progress', '', 'v7')`, [ORG, CLIENT]);
        await client.query(
          `INSERT INTO nzi_console.client_strategy_srs_requirements (organisation_id, client_strategy_id, framework_id, requirement_id)
           VALUES ($1, 'legacy-planned', $2, $3), ($1, 'legacy-live', $2, $3)`, [ORG, requirement.framework_id, requirement.requirement_id]);
        await client.query("COMMIT");
      },
    }))!;
    admin = await database.admin();
    await q(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada Admin')`, [ORG]);
    await q(`INSERT INTO nzi_console.client_contacts (organisation_id, contact_id, client_id, full_name, job_title, status, created_by, updated_by, deactivated_by, deactivated_at) VALUES
      ($1, 'con-priya', $2, 'Priya Shah', 'Facilities Manager', 'active', 'seed', 'seed', NULL, NULL),
      ($1, 'con-gone', $2, 'Old Contact', NULL, 'inactive', 'seed', 'seed', 'seed', now()),
      ($1, 'con-other', $3, 'Someone Else', NULL, 'active', 'seed', 'seed', NULL, NULL)`, [ORG, CLIENT, OTHER]);
    requirementId = (await q<{ requirement_id: string }>(`SELECT requirement_id FROM nzi_console.srs_requirements LIMIT 1`))[0]!.requirement_id;
  });
  after(async () => { await admin?.end(); await database?.end(); });

  describe("the data migration", () => {
    it("moves a planned action to agreed, keeps the free-text owner as legacy text, and gives every row the plan origin", async () => {
      const [legacy] = await q(`SELECT status, legacy_owner_text, owner_contact_id, origin FROM nzi_console.client_strategies WHERE client_strategy_id = 'legacy-planned'`);
      assert.deepEqual(legacy, { status: "agreed", legacy_owner_text: "Facilities team", owner_contact_id: null, origin: "plan" });
      assert.equal((await one("legacy-live")).status, "in_progress", "the rest of the ladder is unchanged");
      assert.equal((await one("legacy-planned")).owner, "Facilities team", "shown until a contact is chosen");
      await assert.rejects(q(`UPDATE nzi_console.client_strategies SET status = 'planned' WHERE client_strategy_id = 'legacy-live'`), /check constraint/);
    });
  });

  describe("the library (R1): admin-managed, versioned, withdrawn rather than deleted", () => {
    let leverId = "";
    let strategyId = "";

    it("adds a lever and a strategy allocated to it, and versions every edit", async () => {
      const lever = await upsertLever(database.pool, { key: "Water", title: "Water", iconKey: "drop" }, context());
      leverId = lever.data.leverId;
      const energy = (await withTenantRead(database.pool, ORG, listLevers)).find((entry) => entry.key === "energy")!;
      const created = await upsertLibraryStrategy(database.pool, {
        key: "rainwater-harvest", title: "Rainwater harvesting", scope: "3", controlLevel: "direct_control", iconKey: "drop", leverIds: [leverId, energy.id],
      }, context());
      strategyId = created.data.strategyId;
      let library = (await withTenantRead(database.pool, ORG, listLibraryStrategies)).find((entry) => entry.id === strategyId)!;
      assert.deepEqual([library.version, [...library.leverIds].sort()], [1, [energy.id, leverId].sort()]);

      const edited = await upsertLibraryStrategy(database.pool, {
        strategyId, expectedVersion: 1, key: "rainwater-harvest", title: "Rainwater harvesting and reuse", scope: "3", controlLevel: "direct_control", iconKey: "drop", leverIds: [leverId],
      }, context());
      library = (await withTenantRead(database.pool, ORG, listLibraryStrategies)).find((entry) => entry.id === strategyId)!;
      assert.deepEqual([edited.data.version, library.title, library.leverIds], [2, "Rainwater harvesting and reuse", [leverId]]);
      await assert.rejects(upsertLibraryStrategy(database.pool, {
        strategyId, expectedVersion: 1, key: "rainwater-harvest", title: "Stale", scope: "3", controlLevel: "direct_control", iconKey: "drop", leverIds: [leverId],
      }, context()), VersionConflictError);
      const audits = await q(`SELECT action, before_json, after_json FROM nzi_console.audit_events WHERE entity_id = $1 ORDER BY occurred_at`, [strategyId]);
      assert.deepEqual(audits.map((row) => row.action), ["reduction_strategy_upserted", "reduction_strategy_upserted"]);
      assert.deepEqual(audits[1]!.before_json.leverIds, [energy.id, leverId].sort());
    });

    it("refuses a strategy under no lever, or under one that does not exist", async () => {
      await assert.rejects(upsertLibraryStrategy(database.pool, { key: "x", title: "X", scope: "1", controlLevel: "direct_control", iconKey: "target", leverIds: [] }, context()), refused("REQUIRED"));
      await assert.rejects(upsertLibraryStrategy(database.pool, { key: "y", title: "Y", scope: "1", controlLevel: "direct_control", iconKey: "target", leverIds: ["lever-nope"] }, context()), refused("NOT_FOUND"));
    });

    it("withdraws a lever without taking it off the strategies under it, and never allocates it anew", async () => {
      const lever = (await withTenantRead(database.pool, ORG, listLevers)).find((entry) => entry.id === leverId)!;
      const withdrawn = await deactivateLever(database.pool, { leverId, expectedVersion: lever.version!, reason: "Folded into Process" }, context("admin", "Folded into Process"));
      assert.equal(withdrawn.data.strategiesUnder, 1);
      assert.deepEqual((await withTenantRead(database.pool, ORG, listLibraryStrategies)).find((entry) => entry.id === strategyId)!.leverIds, [leverId], "kept where it was");
      await assert.rejects(upsertLibraryStrategy(database.pool, { key: "z", title: "Z", scope: "1", controlLevel: "direct_control", iconKey: "target", leverIds: [leverId] }, context()), refused("WITHDRAWN"));
      assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.levers WHERE lever_id = $1`, [leverId]))[0]!.n, 1, "never deleted");
    });

    it("is admin.lookups: a consultant can build a plan from the library but cannot change it", async () => {
      await assert.rejects(upsertLever(database.pool, { key: "air", title: "Air", iconKey: "target" }, context("consultant")), /admin\.lookups|permission|not allowed/i);
    });

    it("withdraws a strategy: kept on the record, no longer offered", async () => {
      const library = (await withTenantRead(database.pool, ORG, listLibraryStrategies)).find((entry) => entry.id === strategyId)!;
      await deactivateLibraryStrategy(database.pool, { strategyId, expectedVersion: library.version, reason: "Superseded" }, context("admin", "Superseded"));
      await assert.rejects(assignClientStrategy(database.pool, { clientId: CLIENT, strategyId, srsRequirementIds: [requirementId] }, context()), refused("WITHDRAWN"));
    });
  });

  describe("the plan (R2–R4): assigned or bespoke, owned by a client contact, on the ladder", () => {
    let fromLibrary = "";
    let bespoke = "";

    it("assigns from the library as Proposed, with an owner who is the client's contact and a target date", async () => {
      const library = (await withTenantRead(database.pool, ORG, listLibraryStrategies)).find((entry) => entry.active)!;
      const assigned = await assignClientStrategy(database.pool, {
        clientId: CLIENT, strategyId: library.id, srsRequirementIds: library.defaultSrsRequirementIds, ownerContactId: "con-priya", targetDate: "2027-03-31",
      }, context());
      fromLibrary = assigned.data.clientStrategyId;
      const action = await one(fromLibrary);
      assert.deepEqual([action.status, action.ownerContactId, action.owner, action.targetDate, action.origin], ["proposed", "con-priya", "Priya Shah", "2027-03-31", "plan"]);
    });

    it("creates a bespoke action the client has already agreed", async () => {
      const assigned = await assignClientStrategy(database.pool, {
        clientId: CLIENT, bespoke: { title: "Replace the Leeds depot boiler", scope: "1", controlLevel: "direct_control", category: "Heating" },
        srsRequirementIds: [requirementId], ownerContactId: "con-priya", status: "agreed",
      }, context());
      bespoke = assigned.data.clientStrategyId;
      assert.deepEqual([(await one(bespoke)).status, (await one(bespoke)).strategyId], ["agreed", null]);
    });

    it("refuses an owner from another client's team — in the command and in the database — and an inactive contact", async () => {
      await assert.rejects(assignClientStrategy(database.pool, { clientId: CLIENT, bespoke: { title: "T", scope: "1", controlLevel: "direct_control" }, srsRequirementIds: [requirementId], ownerContactId: "con-other" }, context()), refused("NOT_A_CONTACT"));
      await assert.rejects(update(bespoke, { ownerContactId: "con-gone" }), refused("INACTIVE"));
      await assert.rejects(q(`UPDATE nzi_console.client_strategies SET owner_contact_id = 'con-other' WHERE client_strategy_id = $1`, [bespoke]), /foreign key/);
    });

    it("choosing a contact retires the legacy free-text owner", async () => {
      await update("legacy-planned", { ownerContactId: "con-priya" });
      const [row] = await q(`SELECT legacy_owner_text, owner_contact_id FROM nzi_console.client_strategies WHERE client_strategy_id = 'legacy-planned'`);
      assert.deepEqual(row, { legacy_owner_text: "", owner_contact_id: "con-priya" });
    });

    it("holds the ladder: Proposed must be agreed before work starts; finished work can only reopen", async () => {
      await assert.rejects(update(fromLibrary, { status: "in_progress" }), refused("ILLEGAL_TRANSITION"));
      await assert.rejects(update(fromLibrary, { status: "complete", progressPct: 100 }), refused("ILLEGAL_TRANSITION"));
      await update(fromLibrary, { status: "agreed" });
      await update(fromLibrary, { status: "in_progress", progressPct: 30 });
      await update(fromLibrary, { status: "on_hold" });
      await update(fromLibrary, { status: "in_progress" });
      await update(fromLibrary, { status: "complete", progressPct: 100 });
      await assert.rejects(update(fromLibrary, { status: "proposed", progressPct: 0 }), refused("ILLEGAL_TRANSITION"));
      await update(fromLibrary, { status: "in_progress", progressPct: 90 });
      const audit = (await q(`SELECT before_json, after_json FROM nzi_console.audit_events WHERE entity_id = $1 AND action = 'client_strategy_updated' ORDER BY (after_json->>'version')::int DESC LIMIT 1`, [fromLibrary]))[0]!;
      assert.deepEqual([audit.before_json.status, audit.after_json.status, audit.after_json.ownerContactId], ["complete", "in_progress", "con-priya"]);
      assert.doesNotMatch(JSON.stringify(audit), /Priya Shah/, "the owner is named by contact id, never by name");
    });

    it("declines and re-proposes", async () => {
      const declined = await assignClientStrategy(database.pool, { clientId: CLIENT, bespoke: { title: "Green roof", scope: "3", controlLevel: "influence" }, srsRequirementIds: [requirementId] }, context());
      const id = declined.data.clientStrategyId;
      await update(id, { status: "declined" });
      await assert.rejects(update(id, { status: "agreed" }), refused("ILLEGAL_TRANSITION"));
      await update(id, { status: "proposed" });
      await update(id, { status: "declined" });
    });
  });

  describe("where an action came from (R6, R7)", () => {
    it("records an SRS-gap action with the requirement it bridges, aligned to it, and never lets the origin change", async () => {
      const assigned = await assignClientStrategy(database.pool, {
        clientId: CLIENT, bespoke: { title: "Board climate oversight", scope: "governance", controlLevel: "direct_control" }, srsRequirementIds: [requirementId],
        origin: "srs_gap", originSrsRequirementId: requirementId,
      }, context());
      const action = await one(assigned.data.clientStrategyId);
      assert.deepEqual([action.origin, action.originSrsRequirementId, action.srsRequirementIds.includes(requirementId)], ["srs_gap", requirementId, true]);
      await assert.rejects(q(`UPDATE nzi_console.client_strategies SET origin = 'plan', origin_srs_framework_id = NULL, origin_srs_requirement_id = NULL WHERE client_strategy_id = $1`,
        [assigned.data.clientStrategyId]), /origin is set when it is created/);
    });

    it("refuses an SRS-gap action that names no requirement, or an unknown one, and a client proposal through the staff command", async () => {
      const base = { clientId: CLIENT, bespoke: { title: "T", scope: "1", controlLevel: "direct_control" }, srsRequirementIds: [requirementId] };
      await assert.rejects(assignClientStrategy(database.pool, { ...base, origin: "srs_gap" }, context()), refused("REQUIRED"));
      await assert.rejects(assignClientStrategy(database.pool, { ...base, origin: "srs_gap", originSrsRequirementId: "req-nope" }, context()), refused("UNKNOWN_REQUIREMENT"));
      await assert.rejects(assignClientStrategy(database.pool, { ...base, origin: "client_proposal" }, context()), refused("INVALID"));
      await assert.rejects(q(`INSERT INTO nzi_console.client_strategies (organisation_id, client_strategy_id, client_id, bespoke_title, bespoke_scope, bespoke_control_level, origin, created_by)
        VALUES ($1, 'bad-gap', $2, 'T', '1', 'direct_control', 'srs_gap', 'x')`, [ORG, CLIENT]), /check constraint/);
    });
  });

  describe("the report and the dashboard (R5)", () => {
    it("composes only included, agreed-or-beyond actions into the report plan, while the plan read shows them all", async () => {
      const hidden = await assignClientStrategy(database.pool, { clientId: CLIENT, bespoke: { title: "Held back", scope: "2", controlLevel: "direct_control" }, srsRequirementIds: [requirementId], status: "agreed" }, context());
      await update(hidden.data.clientStrategyId, { includeInReport: false });
      const [strategies, levers] = await withTenantRead(database.pool, ORG, async (db) => [await listClientStrategies(db, CLIENT), await listLevers(db)] as const);
      const section = composeReportPlan(strategies, levers, new Map());
      assert.ok(!("state" in section), "the plan composes");
      if ("state" in section) return;
      const titles = new Set(section.groups.flatMap((group) => group.strategies.map((strategy) => strategy.title)));
      const live = strategies.filter((strategy) => strategy.active);
      for (const strategy of live) assert.equal(titles.has(strategy.title), strategyIsReportable(strategy), `${strategy.title} (${strategy.status}, include ${strategy.includeInReport})`);
      assert.ok(!titles.has("Held back") && !titles.has("Green roof"), "held back and declined are left out");
      assert.ok(titles.has("Replace the Leeds depot boiler"), "an agreed, included action is in");
      assert.equal(section.excludedCount, live.filter((strategy) => !strategyIsReportable(strategy)).length);
      // The dashboard — the plan read — shows the whole plan regardless.
      assert.ok(live.some((strategy) => strategy.title === "Held back") && live.some((strategy) => strategy.status === "declined"));
    });

    it("carries no money anywhere on the plan", async () => {
      const columns = await q<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'nzi_console' AND table_name = 'client_strategies'`);
      assert.ok(!columns.some((column) => /cost|price|fee|sell|amount_gbp|currency/.test(column.column_name)), columns.map((column) => column.column_name).join(", "));
    });
  });
});
