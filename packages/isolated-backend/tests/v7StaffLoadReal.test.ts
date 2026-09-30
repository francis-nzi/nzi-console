import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { syntheticRows } from "./support/v7SyntheticExtract";
import { sealMembershipRow } from "../src/piiWriteThrough";
import { resolveSealingKeys } from "../src/piiSealingKeys";
import { withTenantWrite } from "../src/postgres";
import { updateStaff } from "../src/staffAdmin";
import { loadV7Staff, planV7Staff, type StaffOutcome } from "../src/v7StaffLoad";

/**
 * The v7 staff import (admin Phase B, B2) against a real database: matched by the address digest (or the plaintext in
 * the dual-write era); position filled when empty, provenance stamped; role, status, name and address never imported
 * onto an existing member; nobody created unless named (Q3), then Viewer under an opaque id, sealed, deactivated if v7
 * has them disabled; portal logins refused; no name or address in the report or any audit payload; R4 re-runs.
 */
describe("load:v7-staff, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "net-zero-international";
  let database: DisposableDatabase;
  const keys = resolveSealingKeys();
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const member = async (userId: string) => (await q(`SELECT * FROM nzi_console.memberships WHERE organisation_id = $1 AND user_id = $2`, [ORG, userId]))[0];
  const users = (change?: (rows: ReturnType<typeof syntheticRows>["users"]) => void) => { const rows = syntheticRows(); change?.(rows.users); return { users: rows.users }; };
  const run = (extract: ReturnType<typeof users>, options: { commit: boolean; create?: string[] }) => loadV7Staff(database.pool, ORG, planV7Staff(extract), { ...options, keys });
  const PERSONAL = /@|ada|ben|cara|dan|erin|example/i;
  // Matched members are named by their console user_id — the actor id the audit already carries (for the twelve seeded
  // members a first.last handle; for anyone added since, a UUID). Everything else in the report must name nobody.
  const reportOf = ({ namesForOperator: _names, matched, ...report }: StaffOutcome) => ({ ...report, matched: matched.map(({ userId: _id, ...entry }) => entry) });

  before(async () => {
    database = (await createDisposableDatabase("v7staffload"))!;
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name, email) VALUES
      ($1, 'ada.example', 'admin', 'active', 'Ada Example', 'ada@example.test'),
      ($1, 'ben.example', 'viewer', 'active', 'Benjamin Example', 'ben@example.test'),
      ($1, 'solo.here', 'viewer', 'active', 'Solo Here', 'solo@example.test')`, [ORG]);
    // Ada is sealed (matched by digest); Ben is not yet (matched by the plaintext beside it, the dual-write era).
    await withTenantWrite(database.pool, ORG, (db) => sealMembershipRow({ db, organisationId: ORG, actorId: "t", keys }, { userId: "ada.example", displayName: "Ada Example", email: "ada@example.test" }));
    await q(`INSERT INTO nzi_console.reference_values (organisation_id, category_key, value_id, label, created_by, updated_by) VALUES
      ($1, 'positions', 'pos-ceo', 'Chief Executive Officer', 's', 's'), ($1, 'positions', 'pos-cco', 'Chief Commercial Officer', 's', 's')`, [ORG]);
  });
  after(async () => { await database?.end(); });

  it("plans only internal staff: a portal login and a shared address are refused; Disabled and archived are inactive", () => {
    const plan = planV7Staff(users());
    assert.deepEqual([plan.v7.total, plan.staff.length, plan.v7.active, plan.v7.inactive], [6, 5, 3, 2]);
    assert.ok(plan.refused.some((refusal) => /portal/.test(refusal.reason)));
    const shared = planV7Staff(users((rows) => { rows.push({ ...rows[0]!, user_id: "x", email: "ADA@example.test" }); }));
    assert.ok(shared.refused.some((refusal) => /share/.test(refusal.reason)) && !shared.staff.some((person) => person.email === "ada@example.test"));
  });

  it("a dry run writes nothing", async () => {
    const outcome = await run(users(), { commit: false });
    assert.equal(outcome.matched.length, 2);
    assert.equal((await member("ada.example")).source_system, null);
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE action LIKE 'staff.%imported'`))[0].n, 0);
  });

  it("commits: positions filled and provenance stamped; role, status, name and address untouched; nobody created unasked", async () => {
    const outcome = await run(users(), { commit: true });
    const ada = await member("ada.example"), ben = await member("ben.example");
    assert.deepEqual([ada.role_id, ada.status, ada.display_name, ada.position_value_id, ada.source_system], ["admin", "active", "Ada Example", "pos-ceo", "nzi-pro-v7"]);
    assert.deepEqual([ben.role_id, ben.status, ben.display_name, ben.position_value_id], ["viewer", "active", "Benjamin Example", "pos-ceo"], "v7 says Admin and 'Ben' — neither applied");
    assert.deepEqual(ada.legacy_values, { role: "SuperAdmin", status: "Active", archived: false, position: "Chief Executive Officer" });
    assert.ok(outcome.matched.find((entry) => entry.userId === "ben.example")!.notes.some((note) => /name here differs/.test(note)));
    assert.equal((await member("solo.here")).source_system, null, "a member v7 lacks is left alone");
    assert.equal(outcome.unmatched.length, 3);
    assert.ok(outcome.unmatched.every((entry) => entry.created === null && /^[0-9a-f]{10}$/.test(entry.ref)));
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.memberships WHERE organisation_id = $1`, [ORG]))[0].n, 3);
    assert.equal(outcome.positions.unmatchedLabels, 1, "'Astronaut' matches no position and none is created");
  });

  it("the report and every audit payload hold no name and no address", async () => {
    const outcome = await run(users(), { commit: false });
    assert.ok(!PERSONAL.test(JSON.stringify(reportOf(outcome))), JSON.stringify(reportOf(outcome)));
    assert.equal(outcome.namesForOperator.length, 3, "the names are kept apart, for the operator's terminal");
    const events = await q(`SELECT action, before_json, after_json FROM nzi_console.audit_events WHERE action IN ('staff.imported', 'staff.roster.imported')`);
    assert.ok(events.length >= 3);
    for (const event of events) {
      const payload = JSON.stringify([event.before_json, event.after_json]).replace(/"userId":"[a-z.]+"/g, "");
      assert.ok(!/@|Ada|Ben|Example/.test(payload), payload);
    }
  });

  it("a re-run with v7 unchanged changes nothing and writes no audit", async () => {
    const before = (await q(`SELECT count(*)::int AS n FROM nzi_console.audit_events`))[0].n;
    const outcome = await run(users(), { commit: true });
    assert.ok(outcome.matched.every((entry) => entry.changed.length === 0));
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.audit_events`))[0].n, before);
  });

  it("creates only the refs it is given: Viewer, opaque id, sealed, deactivated when v7 has them disabled", async () => {
    const dry = await run(users(), { commit: false });
    const byName = new Map(dry.namesForOperator.map((entry) => [entry.name, entry.ref]));
    const [cara, dan] = [byName.get("Cara Example")!, byName.get("Dan Example")!];
    await assert.rejects(run(users(), { commit: false, create: ["0000000000"] }), /no v7 user/);
    const outcome = await run(users(), { commit: true, create: [cara, dan] });
    const created = outcome.unmatched.filter((entry) => entry.created);
    assert.deepEqual(created.map((entry) => entry.created!.status).sort(), ["active", "deactivated"]);
    for (const entry of created) {
      const row = await member(entry.created!.userId);
      assert.match(row.user_id, /^[0-9a-f-]{36}$/);
      assert.equal(row.role_id, "viewer", "never v7's Admin");
      assert.ok(row.display_name_sealed && row.email_sealed && row.email_bidx, "sealed on write");
      assert.equal(row.source_system, "nzi-pro-v7");
    }
    const danRow = await member(created.find((entry) => entry.created!.status === "deactivated")!.created!.userId);
    assert.ok(danRow.deactivated_at && danRow.deactivated_by);
    assert.equal(outcome.unmatched.filter((entry) => !entry.created).length, 1, "Erin was not named, so not created");
    // Now matched by digest, a re-run is quiet.
    const again = await run(users(), { commit: true });
    assert.equal(again.unmatched.length, 1);
  });

  it("R4: v7 moves a position the import set and nobody touched → applied; one edited here → refused, and still refused next time", async () => {
    const moved = users((rows) => { for (const row of rows) if (row.full_name === "Ben Example" || row.full_name === "Ada Example") row.position = "Chief Commercial Officer"; });
    // Ada's position is changed here first.
    const ada = await member("ada.example");
    await updateStaff(database.pool, { userId: "ada.example", expectedVersion: ada.version, displayName: "Ada Example", positionValueId: null }, {
      organisationId: ORG, actorId: "ada.example", principal: "staff", idempotencyKey: "r4-edit", correlationId: "r4-edit", grant: commandGrantForRole("admin", ORG, "ada.example") });
    await withTenantWrite(database.pool, ORG, (db) => db.query(`UPDATE nzi_console.memberships SET position_value_id = 'pos-ceo', updated_by = 'ada.example', version = version + 1 WHERE user_id = 'ada.example'`));
    const outcome = await run(moved, { commit: true });
    assert.equal((await member("ben.example")).position_value_id, "pos-cco", "Ben's import-set position follows v7");
    const adaOutcome = outcome.matched.find((entry) => entry.userId === "ada.example")!;
    assert.match(adaOutcome.conflict ?? "", /set here/);
    assert.equal((await member("ada.example")).position_value_id, "pos-ceo");
    assert.equal(((await member("ada.example")).legacy_values as { position: string }).position, "Chief Executive Officer", "legacy kept, so the conflict stays visible");
    const again = await run(moved, { commit: false });
    assert.ok(again.matched.find((entry) => entry.userId === "ada.example")!.conflict);
  });

  it("v7 disabling someone active here is reported, never applied", async () => {
    const outcome = await run(users((rows) => { rows.find((row) => row.full_name === "Ben Example")!.status = "Disabled"; }), { commit: true });
    assert.ok(outcome.matched.find((entry) => entry.userId === "ben.example")!.notes.some((note) => /disabled; active here/.test(note)));
    assert.equal((await member("ben.example")).status, "active");
  });
});
