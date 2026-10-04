import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext, type CommandInputMap, type OrganisationProfileFields, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { plaintextIn } from "./support/payloadScan";
import { CommandValidationError, createClient } from "../src/postgresCommands";
import { withTenantRead, withTenantWrite } from "../src/postgres";
import {
  applyIntensityDefaults, countClientsWithoutMetrics, deactivateIntensityDefault, listIntensityDefaults, readOrganisationBank, readOrganisationLogo,
  readOrganisationProfile, removeOrganisationLogo, setIntensityDefault, setOrganisationBank, setOrganisationLogo, updateOrganisationProfile,
} from "../src/organisationSettings";

/**
 * Organisation settings (admin Phase D, D1; ruled `phaseD-org-settings-plan.md`) against a real database: 0142's
 * provisioning, grants and CHECKs; the profile (typed, versioned, derived footer, signatory from the roster); the bank
 * details apart — admin.settings only, masked unless revealed, a reason for every change, and no value in any payload;
 * the logo (the client-logo inspector, append-only assets); the intensity defaults (versioned, applied by client.create,
 * and onto existing clients only by the confirmed, audited apply); tenancy.
 */
type Issue = { field: string; code: string };
const issue = (field: string, code?: string) => (error: unknown) =>
  error instanceof CommandValidationError && error.issues.some((item: Issue) => item.field === field && (code === undefined || item.code === code));
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex").toString("base64");

describe("Organisation settings, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "os-org-a";
  const OTHER = "os-org-b";
  let database: DisposableDatabase;
  let keys = 0;
  const context = (actor = "ada", role: StaffRole = "admin", reason?: string, org = ORG): CommandContext => {
    keys += 1;
    return { organisationId: org, actorId: actor, principal: "staff", idempotencyKey: `os-${keys}`, correlationId: `corr-os-${keys}`, ...(reason ? { reason } : {}), grant: commandGrantForRole(role, org, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const profile = () => withTenantRead(database.pool, ORG, (db) => readOrganisationProfile(db, ORG)).then((view) => view!);
  const bankVersion = async () => (await q(`SELECT version FROM nzi_console.organisation_bank_details WHERE organisation_id = $1`, [ORG]))[0].version as number;
  const auditOf = (auditEventId: string) => q(`SELECT action, reason, before_json, after_json FROM nzi_console.audit_events WHERE audit_event_id = $1`, [auditEventId]).then((rows) => rows[0]);
  const blank: OrganisationProfileFields = {
    legalName: null, displayName: null, shortName: null, registrationNumber: null, vatNumber: null, addressLine1: null, addressLine2: null, addressCity: null, addressRegion: null,
    addressPostcode: null, addressCountry: null, contactEmail: null, contactPhone: null, websiteUrl: null, footerOverride: null, signatoryUserId: null, signatoryTitle: null,
  };

  before(async () => {
    database = (await createDisposableDatabase("orgsettings"))!;
    for (const org of [ORG, OTHER]) {
      await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $2)`, [org, org === ORG ? "Example Organisation" : "Other Organisation"]);
      await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name, email) VALUES
        ($1, 'ada', 'admin', 'active', 'Ada Admin', 'ada@' || $1 || '.test'), ($1, 'cal', 'consultant', 'active', 'Cal Consultant', 'cal@' || $1 || '.test'),
        ($1, 'fin', 'finance', 'active', 'Fin Finance', 'fin@' || $1 || '.test')`, [org]);
    }
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name, deactivated_at, deactivated_by) VALUES ($1, 'gone', 'viewer', 'deactivated', 'Gone Person', now(), 'ada')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, 'c-old-1', 'Old One', 'active'), ($1, 'c-old-2', 'Old Two', 'active'), ($1, 'c-has', 'Has Metrics', 'active')`, [ORG]);
    await q(`INSERT INTO nzi_console.client_intensity_metrics (organisation_id, client_id, metric_key, version, label, unit_wording, set_by, correlation_id) VALUES ($1, 'c-has', 'beds', 1, 'Beds', 'bed', 's', 's')`, [ORG]);
  });
  after(async () => { await database?.end(); });

  describe("0142", () => {
    it("provisions a profile, a bank row and the standard defaults for a new organisation, by its own trigger", async () => {
      const [row] = await q(`SELECT p.display_name, p.version, b.account_number, (SELECT count(*)::int FROM nzi_console.organisation_intensity_metric_defaults d WHERE d.organisation_id = p.organisation_id) AS defaults
        FROM nzi_console.organisation_profiles p JOIN nzi_console.organisation_bank_details b USING (organisation_id) WHERE p.organisation_id = $1`, [ORG]);
      assert.deepEqual([row.display_name, row.version, row.account_number, row.defaults], ["Example Organisation", 1, null, 2]);
      const defaults = await withTenantRead(database.pool, ORG, (db) => listIntensityDefaults(db, ORG));
      assert.deepEqual(defaults.map((entry) => [entry.metricKey, entry.unitWording, entry.divider, entry.isStandard]), [["employees", "employee", 1, true], ["turnover", "£m", 1000000, true]]);
    });

    it("the application may only update the provisioned rows: no INSERT, no DELETE; defaults and assets append-only", async () => {
      await assert.rejects(withTenantWrite(database.pool, ORG, (db) => db.query(`INSERT INTO nzi_console.organisation_profiles (organisation_id, updated_by) VALUES ($1, 'x')`, [ORG])), /permission denied/);
      await assert.rejects(withTenantWrite(database.pool, ORG, (db) => db.query(`DELETE FROM nzi_console.organisation_bank_details`)), /permission denied/);
      await assert.rejects(withTenantWrite(database.pool, ORG, (db) => db.query(`UPDATE nzi_console.organisation_intensity_metric_defaults SET label = 'x'`)), /permission denied/);
      await assert.rejects(withTenantWrite(database.pool, ORG, (db) => db.query(`DELETE FROM nzi_console.organisation_logo_assets`)), /permission denied/);
    });

    it("holds the bank details whole or not at all, in their shapes", async () => {
      await assert.rejects(q(`UPDATE nzi_console.organisation_bank_details SET sort_code = '123456' WHERE organisation_id = $1`, [ORG]), /organisation_bank_details_whole/);
      await assert.rejects(q(`UPDATE nzi_console.organisation_bank_details SET account_name = 'A', sort_code = '12-34-56', account_number = '12345678' WHERE organisation_id = $1`, [ORG]), /sort_code_check/);
    });
  });

  describe("the profile", () => {
    it("saves a whole, normalised profile under its version; the payload names fields, never values; the footer is derived", async () => {
      const input: CommandInputMap["organisation.profile.update"] = {
        ...blank, legalName: "  Example   Organisation Limited ", displayName: "Example Org", registrationNumber: "ab 123456", vatNumber: "gb 123 4567 89",
        addressLine1: "1 Example Street", addressCity: "London", addressPostcode: "EX1 2MP", addressCountry: "United Kingdom", websiteUrl: "https://example.test/",
        signatoryUserId: "ada", signatoryTitle: "Director", expectedVersion: 1,
      };
      const done = await updateOrganisationProfile(database.pool, input, context());
      const view = await profile();
      assert.deepEqual([view.fields.legalName, view.fields.registrationNumber, view.fields.vatNumber, view.version], ["Example Organisation Limited", "AB123456", "GB123456789", 2]);
      assert.equal(view.footer, "Example Organisation Limited | example.test | Company No. AB123456 | VAT No. GB123456789");
      assert.deepEqual(view.signatory, { userId: "ada", name: "Ada Admin", active: true });
      const audit = await auditOf(done.auditEventId);
      assert.equal(audit.action, "organisation.profile.updated");
      assert.ok(audit.after_json.changed.includes("vatNumber"));
      assert.ok(!/Example|GB123|London|Director/.test(JSON.stringify([audit.before_json, audit.after_json])), "no value in the audit");
      assert.equal("bank" in view, false, "the profile read never carries bank details");
    });

    it("an override replaces the derived footer; clearing it restores the derived one", async () => {
      const current = await profile();
      await updateOrganisationProfile(database.pool, { ...current.fields, footerOverride: "Custom footer", expectedVersion: current.version }, context());
      assert.deepEqual([(await profile()).footer, (await profile()).footerDerived], ["Custom footer", false]);
      const again = await profile();
      await updateOrganisationProfile(database.pool, { ...again.fields, footerOverride: null, expectedVersion: again.version }, context());
      assert.match((await profile()).footer, /^Example Organisation Limited \|/);
    });

    it("refuses bad values, no change, a stale version, an inactive signatory, a title with no signatory, and non-admin.settings roles", async () => {
      const current = await profile();
      const base = { ...current.fields, expectedVersion: current.version };
      await assert.rejects(updateOrganisationProfile(database.pool, { ...base, vatNumber: "not a vat!" }, context()), issue("vatNumber", "INVALID"));
      await assert.rejects(updateOrganisationProfile(database.pool, { ...base, websiteUrl: "example.test" }, context()), issue("websiteUrl", "INVALID"));
      await assert.rejects(updateOrganisationProfile(database.pool, base, context()), issue("organisationId", "NO_CHANGE"));
      await assert.rejects(updateOrganisationProfile(database.pool, { ...base, legalName: "X", expectedVersion: current.version - 1 }, context()), /version|changed/i);
      await assert.rejects(updateOrganisationProfile(database.pool, { ...base, signatoryUserId: "gone" }, context()), issue("signatoryUserId", "INACTIVE"));
      await assert.rejects(updateOrganisationProfile(database.pool, { ...base, signatoryUserId: null }, context()), issue("signatoryTitle", "NO_SIGNATORY"));
      for (const [actor, role] of [["cal", "consultant"], ["fin", "finance"]] as const) {
        await assert.rejects(updateOrganisationProfile(database.pool, { ...base, legalName: "Y" }, context(actor, role)), /admin\.settings|permission/i);
      }
    });
  });

  describe("the bank details", () => {
    it("need a reason; are masked unless revealed; and never reach a payload", async () => {
      const input = { accountName: "Example Organisation Ltd", sortCode: "12-34-56", accountNumber: "87654321", expectedVersion: await bankVersion() };
      await assert.rejects(setOrganisationBank(database.pool, input, context()), issue("reason", "REQUIRED"));
      const done = await setOrganisationBank(database.pool, input, context("ada", "admin", "Opened the business account"));
      const holder = { capabilities: commandGrantForRole("admin", ORG, "ada").capabilities };
      const masked = await withTenantRead(database.pool, ORG, (db) => readOrganisationBank(db, holder, ORG, { reveal: false }));
      assert.deepEqual([masked.sortCode, masked.accountNumber, masked.configured, masked.revealed], ["••-••-56", "•••• 4321", true, false]);
      const shown = await withTenantRead(database.pool, ORG, (db) => readOrganisationBank(db, holder, ORG, { reveal: true }));
      assert.deepEqual([shown.sortCode, shown.accountNumber], ["12-34-56", "87654321"]);
      const audit = await auditOf(done.auditEventId);
      assert.deepEqual([audit.action, audit.reason, audit.after_json.changed], ["organisation.bank.set", "Opened the business account", ["accountName", "sortCode", "accountNumber"]]);
      const stored = [audit, await q(`SELECT outcome_json FROM nzi_console.command_idempotency WHERE outcome_json->>'auditEventId' = $1`, [done.auditEventId]),
        await q(`SELECT payload_json FROM nzi_console.transactional_outbox WHERE correlation_id = $1`, [done.correlationId])];
      // Structural: the rows carry UUIDs and microsecond timestamps, whose digits can hold "4321" or "123456" by chance.
      assert.deepEqual(plaintextIn(stored, ["87654321", "123456", "4321", "Example Organisation Ltd"]), [], "a bank value reached a payload");
    });

    it("are admin.settings only — Finance and Consultant are refused the read and the write", async () => {
      for (const role of ["finance", "consultant"] as const) {
        const holder = { capabilities: commandGrantForRole(role, ORG, "x").capabilities };
        await assert.rejects(withTenantRead(database.pool, ORG, (db) => readOrganisationBank(db, holder, ORG, { reveal: false })), /admin\.settings/);
        await assert.rejects(setOrganisationBank(database.pool, { accountName: null, sortCode: null, accountNumber: null, expectedVersion: await bankVersion() }, context(role === "finance" ? "fin" : "cal", role, "try")), /admin\.settings|permission/i);
      }
    });

    it("are whole or cleared, never half", async () => {
      await assert.rejects(setOrganisationBank(database.pool, { accountName: "A", sortCode: null, accountNumber: null, expectedVersion: await bankVersion() }, context("ada", "admin", "half")), issue("sortCode", "REQUIRED"));
      await setOrganisationBank(database.pool, { accountName: null, sortCode: null, accountNumber: null, expectedVersion: await bankVersion() }, context("ada", "admin", "Closed"));
      const holder = { capabilities: commandGrantForRole("admin", ORG, "ada").capabilities };
      assert.equal((await withTenantRead(database.pool, ORG, (db) => readOrganisationBank(db, holder, ORG, { reveal: true }))).configured, false);
    });
  });

  describe("the logo", () => {
    it("uses the client-logo inspector, keeps every asset, and removing clears only the pointer", async () => {
      await assert.rejects(setOrganisationLogo(database.pool, { fileName: "x.svg", contentType: "image/svg+xml", dataBase64: Buffer.from('<svg onload="alert(1)"></svg>').toString("base64") }, context()), issue("dataBase64", "INVALID_LOGO"));
      await assert.rejects(setOrganisationLogo(database.pool, { fileName: "x.png", contentType: "image/png", dataBase64: Buffer.from("not a png").toString("base64") }, context()), issue("dataBase64", "INVALID_LOGO"));
      const set = await setOrganisationLogo(database.pool, { fileName: "logo.png", contentType: "image/png", dataBase64: PNG }, context());
      const logo = await withTenantRead(database.pool, ORG, (db) => readOrganisationLogo(db, ORG));
      assert.equal(logo?.assetId, set.data.assetId);
      await removeOrganisationLogo(database.pool, {}, context());
      assert.equal(await withTenantRead(database.pool, ORG, (db) => readOrganisationLogo(db, ORG)), null);
      assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.organisation_logo_assets WHERE organisation_id = $1`, [ORG]))[0].n, 1, "the asset is kept");
      await assert.rejects(removeOrganisationLogo(database.pool, {}, context()), issue("logo", "NO_LOGO"));
    });
  });

  describe("the intensity defaults", () => {
    it("are versioned: a change writes the next version; a deactivated default is not applied", async () => {
      await setIntensityDefault(database.pool, { metricKey: "floor-space", label: "Floor space", unitWording: "m²", divider: 1, iconKey: "building", expectedVersion: 0 }, context());
      await setIntensityDefault(database.pool, { metricKey: "floor-space", label: "Floor area", unitWording: "m²", divider: 100, iconKey: "building", expectedVersion: 1 }, context());
      await deactivateIntensityDefault(database.pool, { metricKey: "floor-space", expectedVersion: 2 }, context());
      const floor = (await withTenantRead(database.pool, ORG, (db) => listIntensityDefaults(db, ORG))).find((entry) => entry.metricKey === "floor-space")!;
      assert.deepEqual([floor.version, floor.label, floor.divider, floor.active], [3, "Floor area", 100, false]);
      await assert.rejects(setIntensityDefault(database.pool, { metricKey: "floor-space", label: "X", unitWording: "m²", divider: 1, iconKey: "building", expectedVersion: 1 }, context()), /version|changed/i);
    });

    it("client.create gives a new client the active defaults", async () => {
      const created = await createClient(database.pool, { name: "New Co", status: "active", sector: "Retail", location: "Leeds", owner: "Ada" } as CommandInputMap["client.create"], context());
      const metrics = await q(`SELECT metric_key, version, is_standard FROM nzi_console.client_intensity_metrics WHERE client_id = $1 ORDER BY metric_key`, [created.data.clientId]);
      assert.deepEqual(metrics.map((row) => [row.metric_key, row.version, row.is_standard]), [["employees", 1, true], ["turnover", 1, true]], "the deactivated floor-space default is not applied");
    });

    it("reach existing clients only through the confirmed, audited apply — only clients with none", async () => {
      const without = await withTenantRead(database.pool, ORG, (db) => countClientsWithoutMetrics(db, ORG));
      assert.equal(without, 2, "the two old clients; the one with metrics and the new one are not counted");
      await assert.rejects(applyIntensityDefaults(database.pool, { expectedClients: without }, context()), issue("reason", "REQUIRED"));
      await assert.rejects(applyIntensityDefaults(database.pool, { expectedClients: without + 5 }, context("ada", "admin", "Backfill")), issue("expectedClients", "COUNT_CHANGED"));
      await assert.rejects(applyIntensityDefaults(database.pool, { expectedClients: without }, context("cal", "consultant", "Backfill")), /admin\.settings|permission/i);
      const done = await applyIntensityDefaults(database.pool, { expectedClients: without }, context("ada", "admin", "Backfill the imported clients"));
      assert.deepEqual([done.data.clients, done.data.metrics], [2, 4]);
      assert.deepEqual((await q(`SELECT metric_key FROM nzi_console.client_intensity_metrics WHERE client_id = 'c-has'`)).map((row) => row.metric_key), ["beds"], "a client with metrics is untouched");
      assert.equal(await withTenantRead(database.pool, ORG, (db) => countClientsWithoutMetrics(db, ORG)), 0);
      const audits = await q(`SELECT action, reason FROM nzi_console.audit_events WHERE correlation_id = $1`, [done.correlationId]);
      assert.deepEqual(audits.map((row) => [row.action, row.reason]), [["organisation.intensity_defaults.applied", "Backfill the imported clients"]]);
    });
  });

  it("is per organisation: another organisation sees none of it", async () => {
    const theirs = await withTenantRead(database.pool, OTHER, (db) => readOrganisationProfile(db, ORG));
    assert.equal(theirs, null);
    const rows = await withTenantRead(database.pool, OTHER, (db) => db.query<{ n: number }>(`SELECT (SELECT count(*) FROM nzi_console.organisation_profiles)::int + (SELECT count(*) FROM nzi_console.organisation_bank_details)::int AS n`));
    assert.equal(rows.rows[0]?.n, 2, "only its own profile and bank rows");
  });
});
