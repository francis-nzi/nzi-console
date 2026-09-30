import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { syntheticRows } from "./support/v7SyntheticExtract";
import { updateOrganisationProfile, readOrganisationProfile } from "../src/organisationSettings";
import { withTenantRead } from "../src/postgres";
import { loadV7OrgSettings, planV7OrgSettings, type OrgSettingsOutcome } from "../src/v7OrgSettingsLoad";

/**
 * The v7 organisation-profile import (admin Phase D, D2) against a real database: fill-empty-only (a value here is never
 * overwritten — "differs" is reported); the provisioned display name replaced while nobody has edited the profile; the
 * profile's own rules applied; the logo through the inspector; per-field digests, never values, in legacy_values;
 * a bank row in the extract refuses everything; no value in the outcome or the audit; idempotent re-runs.
 */
describe("load:v7-org-settings, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "net-zero-international";
  let database: DisposableDatabase;
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  /** The allow-listed keys only, as the keys filter copies them. */
  const extract = (change?: (rows: ReturnType<typeof syntheticRows>["system_settings"]) => void) => {
    const rows = syntheticRows().system_settings.filter((row) => !String(row.setting_key).startsWith("bank_") && row.setting_key !== "archive_retention_days");
    change?.(rows);
    return { system_settings: rows };
  };
  const run = (options: { commit: boolean }, data = extract()) => loadV7OrgSettings(database.pool, ORG, planV7OrgSettings(data), options);
  const state = (outcome: OrgSettingsOutcome, field: string) => outcome.fields.find((entry) => entry.field === field)?.state;
  const VALUES = /Example|London|EX1|12345678|123456789|info@|example\.test/;

  before(async () => {
    database = (await createDisposableDatabase("v7orgsettings"))!;
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada Admin')`, [ORG]);
  });
  after(async () => { await database?.end(); });

  it("refuses the whole load when a bank row is in the extract — nothing written", async () => {
    const plan = planV7OrgSettings({ system_settings: syntheticRows().system_settings });
    assert.match(plan.refused ?? "", /bank-detail row/);
    const outcome = await loadV7OrgSettings(database.pool, ORG, plan, { commit: true });
    assert.equal(outcome.fields.length, 0);
    assert.equal((await q(`SELECT source_system FROM nzi_console.organisation_profiles WHERE organisation_id = $1`, [ORG]))[0].source_system, null);
  });

  it("a dry run writes nothing", async () => {
    const outcome = await run({ commit: false });
    assert.equal(state(outcome, "legalName"), "filled");
    assert.equal((await q(`SELECT legal_name FROM nzi_console.organisation_profiles WHERE organisation_id = $1`, [ORG]))[0].legal_name, null);
  });

  it("commits: fills the empty fields (and the provisioned display name), normalised; blank v7 fields stay empty; the logo arrives", async () => {
    const outcome = await run({ commit: true });
    const view = (await withTenantRead(database.pool, ORG, (db) => readOrganisationProfile(db, ORG)))!;
    assert.deepEqual([view.fields.legalName, view.fields.displayName, view.fields.addressLine2, view.fields.websiteUrl, view.fields.contactEmail],
      ["Example Organisation Limited", "Example Org", null, "https://example.test", "info@example.test"]);
    assert.deepEqual([state(outcome, "displayName"), state(outcome, "addressLine2"), state(outcome, "contactPhone"), outcome.logo], ["filled", "blank-in-v7", "blank-in-v7", "filled"]);
    assert.ok(view.logo && view.logo.contentType === "image/png");
    assert.equal(view.provenance, "v7");
    assert.match(view.footer, /^Example Organisation Limited \| example\.test \| Company No\. 12345678 \| VAT No\. 123456789$/);
    const [row] = await q(`SELECT legacy_values FROM nzi_console.organisation_profiles WHERE organisation_id = $1`, [ORG]);
    assert.ok(Object.values(row.legacy_values as Record<string, string>).every((value) => /^[0-9a-f]{64}$/.test(value)), "digests only");
    assert.ok(!VALUES.test(JSON.stringify(row.legacy_values)));
  });

  it("the outcome and the audit carry no value", async () => {
    const outcome = await run({ commit: false });
    assert.ok(!VALUES.test(JSON.stringify(outcome)), JSON.stringify(outcome));
    const audits = await q(`SELECT before_json, after_json FROM nzi_console.audit_events WHERE action = 'organisation.profile.imported'`);
    assert.equal(audits.length, 1);
    assert.ok(!VALUES.test(JSON.stringify(audits)), JSON.stringify(audits));
  });

  it("a re-run is quiet: everything unchanged, no write, no audit", async () => {
    const before = (await q(`SELECT version FROM nzi_console.organisation_profiles WHERE organisation_id = $1`, [ORG]))[0].version;
    const outcome = await run({ commit: true });
    assert.ok(outcome.fields.every((entry) => entry.state !== "filled"));
    assert.equal(outcome.logo, "unchanged");
    assert.equal((await q(`SELECT version FROM nzi_console.organisation_profiles WHERE organisation_id = $1`, [ORG]))[0].version, before);
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE action = 'organisation.profile.imported'`))[0].n, 1);
  });

  it("never overwrites a value set here: 'differs' is reported, and v7's later change is flagged, not applied", async () => {
    const view = (await withTenantRead(database.pool, ORG, (db) => readOrganisationProfile(db, ORG)))!;
    await updateOrganisationProfile(database.pool, { ...view.fields, legalName: "Renamed Here Limited", expectedVersion: view.version }, {
      organisationId: ORG, actorId: "ada", principal: "staff", idempotencyKey: "rename", correlationId: "rename", grant: commandGrantForRole("admin", ORG, "ada") });
    const outcome = await run({ commit: true }, extract((rows) => { rows.find((row) => row.setting_key === "company_legal_name")!.setting_value = "Example Organisation Holdings Limited"; }));
    const legal = outcome.fields.find((entry) => entry.field === "legalName")!;
    assert.deepEqual([legal.state, legal.v7ChangedSinceImport], ["differs", true]);
    assert.equal((await withTenantRead(database.pool, ORG, (db) => readOrganisationProfile(db, ORG)))!.fields.legalName, "Renamed Here Limited");
  });

  it("leaves out a v7 value the profile's rules refuse, and says which rule", () => {
    const plan = planV7OrgSettings(extract((rows) => { rows.find((row) => row.setting_key === "website_url")!.setting_value = "example.test"; }));
    assert.deepEqual(plan.invalid, [{ field: "websiteUrl", code: "INVALID" }]);
    assert.equal(plan.fields.websiteUrl, undefined);
  });
});
