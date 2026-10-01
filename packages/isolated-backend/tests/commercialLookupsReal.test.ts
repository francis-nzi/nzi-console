import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, currencySymbol, setCurrencyDirectory, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  createCurrency, createVatRate, deactivateCurrency, deactivateVatRate, listCurrenciesPage, listVatRatesPage, readCurrencyDirectory,
  reinstateVatRate, setDefaultCurrency, setDefaultVatRate, updateCurrency, updateVatRate,
} from "../src/commercialLookups";
import { updateClient } from "../src/postgresCommands";
import { withTenantRead } from "../src/postgres";

/**
 * Commercial lookups (admin Phase E1; ruled `phaseE-commercial-catalogue-plan.md`, E-Q1–E-Q3) against a real database.
 * A pre-E1 world is seeded straight after 0144, so 0145's own work is what is tested: the one "UAE" client corrected to
 * AED (audited, version bumped), each organisation's starting currencies (GBP the default and every currency its clients
 * hold — no "UAE"), a new organisation provisioned with GBP, the grants (a code set once, nothing deleted), and exactly
 * one default for currencies and VAT rates, checked at commit. Then the vat.* and currency.* commands, client.update's
 * currency rule (a change must be active; a held value stands), and the directory currencySymbol reads.
 */
const NZI = "net-zero-international";
const DEMO = "lookups-demo";
const LATER = "lookups-later";

describe("Commercial lookups (0145), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let keys = 0;
  const context = (actor: string, role: StaffRole, org = NZI, reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: org, actorId: actor, principal: "staff", idempotencyKey: `lookups-${keys}`, correlationId: `corr-lookups-${keys}`, ...(reason ? { reason } : {}), grant: commandGrantForRole(role, org, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  /** One statement as nzi_console_app in a tenant. */
  const asApp = async (org: string, sql: string, params: unknown[] = []) => {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE nzi_console_app");
      await client.query(`SELECT set_config('app.organisation_id', $1, true)`, [org]);
      const rows = (await client.query(sql, params)).rows;
      await client.query("COMMIT");
      return rows;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  /** A pre-E1 world, written straight after 0144 — before 0145 exists. */
  const seedBefore0145 = async (admin: pg.Client) => {
    await admin.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, 'Net Zero International') ON CONFLICT DO NOTHING`, [NZI]);
    await admin.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, 'Lookups Demo')`, [DEMO]);
    await admin.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES
      ($1, 'c-gbp', 'Sterling Client', 'active', 'GBP'), ($1, 'c-uae', 'Dirham Client', 'active', 'UAE'), ($1, 'c-eur', 'Euro Client', 'active', 'EUR')`, [NZI]);
    await admin.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, 'd-gbp', 'Demo Client', 'active', 'GBP')`, [DEMO]);
    // NZI's three imported VAT rates, one default (as C4 left them); the demo organisation holds none.
    await admin.query(`INSERT INTO nzi_console.vat_rates (organisation_id, vat_rate_id, name, rate_pct, is_default, created_by, updated_by) VALUES
      ($1, 'vat:v7-1', '20% Standard Rate', 20, true, 'seed', 'seed'), ($1, 'vat:v7-2', 'No VAT', 0, false, 'seed', 'seed'), ($1, 'vat:v7-3', '5%', 5, false, 'seed', 'seed')`, [NZI]);
  };

  before(async () => {
    database = (await createDisposableDatabase("commerciallookups", {
      onMigration: async (filename, admin) => { if (filename === "0144_trainee_pending_email_read.sql") await seedBefore0145(admin); },
    }))!;
    for (const org of [NZI, DEMO]) {
      await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada Admin'), ($1, 'cal', 'consultant', 'active', 'Cal Consultant')`, [org]);
    }
  });
  after(async () => { await database?.end(); });

  describe("what 0145 did to the pre-E1 world", () => {
    it("corrected the one \"UAE\" client to AED — value for value, version bumped, audited", async () => {
      const [client] = await q(`SELECT currency, version FROM nzi_console.clients WHERE client_id = 'c-uae'`);
      assert.deepEqual([client.currency, client.version], ["AED", 2]);
      assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.clients WHERE currency = 'UAE'`))[0].n, 0);
      const audit = await q(`SELECT organisation_id, entity_id, client_id, actor_id, before_json, after_json FROM nzi_console.audit_events WHERE action = 'client.currency.corrected'`);
      assert.equal(audit.length, 1);
      assert.deepEqual([audit[0].organisation_id, audit[0].entity_id, audit[0].client_id, audit[0].actor_id, audit[0].before_json.currency, audit[0].after_json.currency],
        [NZI, "c-uae", "c-uae", "migration:0145", "UAE", "AED"]);
    });

    it("seeded each organisation's currencies: GBP the default, and every currency its clients hold — never \"UAE\"", async () => {
      const rows = await q(`SELECT organisation_id, code, name, symbol, is_default, active, created_by FROM nzi_console.currencies WHERE organisation_id IN ($1, $2) ORDER BY 1, 2`, [DEMO, NZI]);
      assert.deepEqual(rows.map((row) => [row.organisation_id, row.code, row.symbol, row.is_default]), [
        [DEMO, "GBP", "£", true],
        [NZI, "AED", "AED", false], [NZI, "EUR", "€", false], [NZI, "GBP", "£", true],
      ]);
      assert.ok(rows.every((row) => row.active && row.created_by === "migration:0145"));
      assert.equal(rows.find((row) => row.code === "AED")?.name, "UAE dirham");
    });

    it("provisions a new organisation with GBP as its default currency", async () => {
      await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, 'Later Org')`, [LATER]);
      const rows = await q(`SELECT code, is_default FROM nzi_console.currencies WHERE organisation_id = $1`, [LATER]);
      assert.deepEqual(rows.map((row) => [row.code, row.is_default]), [["GBP", true]]);
    });

    it("refuses \"UAE\" as a code, a second default, and a default that is inactive", async () => {
      await assert.rejects(q(`INSERT INTO nzi_console.currencies (organisation_id, code, name, symbol, created_by, updated_by) VALUES ($1, 'UAE', 'x', 'x', 's', 's')`, [NZI]), /currencies_not_the_country/);
      await assert.rejects(q(`INSERT INTO nzi_console.currencies (organisation_id, code, name, symbol, is_default, created_by, updated_by) VALUES ($1, 'USD', 'US dollar', '$', true, 's', 's')`, [NZI]), /currencies_one_default/);
      await assert.rejects(q(`UPDATE nzi_console.currencies SET active = false WHERE organisation_id = $1 AND code = 'GBP'`, [NZI]), /currencies_default_is_active/);
    });

    it("holds exactly one default at commit — for currencies and for VAT rates", async () => {
      await assert.rejects(q(`UPDATE nzi_console.currencies SET is_default = false WHERE organisation_id = $1 AND code = 'GBP'`, [NZI]), /ONE_DEFAULT/);
      await assert.rejects(q(`UPDATE nzi_console.vat_rates SET is_default = false WHERE organisation_id = $1 AND vat_rate_id = 'vat:v7-1'`, [NZI]), /ONE_DEFAULT/);
      // Moving it — clear, then set, in one transaction — commits.
      const admin = await database.admin();
      try {
        await admin.query("BEGIN");
        await admin.query(`UPDATE nzi_console.vat_rates SET is_default = false WHERE organisation_id = $1 AND vat_rate_id = 'vat:v7-1'`, [NZI]);
        await admin.query(`UPDATE nzi_console.vat_rates SET is_default = true WHERE organisation_id = $1 AND vat_rate_id = 'vat:v7-3'`, [NZI]);
        await admin.query("COMMIT");
        await admin.query("BEGIN");
        await admin.query(`UPDATE nzi_console.vat_rates SET is_default = false WHERE organisation_id = $1 AND vat_rate_id = 'vat:v7-3'`, [NZI]);
        await admin.query(`UPDATE nzi_console.vat_rates SET is_default = true WHERE organisation_id = $1 AND vat_rate_id = 'vat:v7-1'`, [NZI]);
        await admin.query("COMMIT");
      } finally { await admin.end(); }
      // An organisation with no rows needs no default.
      assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.vat_rates WHERE organisation_id = $1`, [DEMO]))[0].n, 0);
    });

    it("sets a code once and deletes nothing: the app role cannot change a code, or delete a currency or a VAT rate", async () => {
      await assert.rejects(asApp(NZI, `UPDATE nzi_console.currencies SET code = 'XXX' WHERE code = 'EUR'`), /permission denied/);
      await assert.rejects(asApp(NZI, `DELETE FROM nzi_console.currencies WHERE code = 'EUR'`), /permission denied/);
      await assert.rejects(asApp(NZI, `DELETE FROM nzi_console.vat_rates WHERE vat_rate_id = 'vat:v7-2'`), /permission denied/);
      assert.deepEqual((await asApp(DEMO, `SELECT code FROM nzi_console.currencies ORDER BY code`)).map((row) => row.code), ["GBP"], "tenant-confined");
    });
  });

  describe("the vat.* commands", () => {
    it("makes an organisation's first rate its default, and later ones not", async () => {
      const first = await createVatRate(database.pool, { name: "Standard", ratePct: 20 }, context("ada", "admin", DEMO));
      const second = await createVatRate(database.pool, { name: "Reduced", ratePct: 5 }, context("ada", "admin", DEMO));
      assert.deepEqual([first.data.isDefault, second.data.isDefault], [true, false]);
      await assert.rejects(createVatRate(database.pool, { name: "standard", ratePct: 17.5 }, context("ada", "admin", DEMO)), /Command validation failed/, "a name belongs to one rate, case-insensitively");
      await assert.rejects(createVatRate(database.pool, { name: "Silly", ratePct: 120 }, context("ada", "admin", DEMO)), /Command validation failed/);
      await assert.rejects(createVatRate(database.pool, { name: "Fractional", ratePct: 12.345 }, context("ada", "admin", DEMO)), /Command validation failed/);
    });

    it("edits, moves the default (with a reason), and never deactivates the default", async () => {
      const page = await withTenantRead(database.pool, NZI, (db) => listVatRatesPage(db, { search: "", filters: {}, sort: { key: "ratePct", dir: "desc" }, page: 1, pageSize: 25 }));
      assert.deepEqual(page.rows.map((row) => [row.name, row.ratePct, row.isDefault]), [["20% Standard Rate", 20, true], ["5%", 5, false], ["No VAT", 0, false]]);
      const reduced = page.rows.find((row) => row.name === "5%")!;
      const edited = await updateVatRate(database.pool, { vatRateId: reduced.vatRateId, name: "Reduced rate", ratePct: 5, expectedVersion: reduced.version }, context("ada", "admin"));
      await assert.rejects(setDefaultVatRate(database.pool, { vatRateId: reduced.vatRateId, expectedVersion: edited.data.version }, context("ada", "admin")), (error: Error & { issues?: Array<{ field: string }> }) => error.issues?.some((issue) => issue.field === "reason") === true, "moving the default needs a reason");
      const moved = await setDefaultVatRate(database.pool, { vatRateId: reduced.vatRateId, expectedVersion: edited.data.version }, context("ada", "admin", NZI, "Most of the work is now reduced-rate"));
      assert.deepEqual([moved.data.isDefault, moved.data.previousDefault], [true, "vat:v7-1"]);
      await assert.rejects(deactivateVatRate(database.pool, { vatRateId: reduced.vatRateId, expectedVersion: moved.data.version }, context("ada", "admin", NZI, "no")), /Command validation failed/);
      const old = (await q(`SELECT version FROM nzi_console.vat_rates WHERE vat_rate_id = 'vat:v7-1'`))[0].version;
      const off = await deactivateVatRate(database.pool, { vatRateId: "vat:v7-1", expectedVersion: old }, context("ada", "admin", NZI, "Retired for the test"));
      assert.equal(off.data.active, false);
      await reinstateVatRate(database.pool, { vatRateId: "vat:v7-1", expectedVersion: off.data.version }, context("ada", "admin"));
      const audit = await q(`SELECT action FROM nzi_console.audit_events WHERE entity_type = 'vat_rate' AND organisation_id = $1 ORDER BY occurred_at`, [NZI]);
      assert.deepEqual(audit.map((row) => row.action), ["vat.updated", "vat.default_set", "vat.deactivated", "vat.reinstated"]);
    });

    it("is admin.lookups: a consultant may not add a rate", async () => {
      await assert.rejects(createVatRate(database.pool, { name: "Consultant's", ratePct: 1 }, context("cal", "consultant", DEMO)), /admin\.lookups|permission/i);
    });
  });

  describe("the currency.* commands", () => {
    it("adds a currency by its ISO code once — never \"UAE\", never twice", async () => {
      const usd = await createCurrency(database.pool, { code: "USD", name: "US dollar", symbol: "$" }, context("ada", "admin"));
      assert.deepEqual([usd.data.code, usd.data.isDefault, usd.data.active], ["USD", false, true]);
      await assert.rejects(createCurrency(database.pool, { code: "UAE", name: "Dirham", symbol: "AED" }, context("ada", "admin")), /Command validation failed/);
      await assert.rejects(createCurrency(database.pool, { code: "usd", name: "US dollar", symbol: "$" }, context("ada", "admin")), /Command validation failed/, "capitals only");
      await assert.rejects(createCurrency(database.pool, { code: "USD", name: "Again", symbol: "$" }, context("ada", "admin")), /Command validation failed/);
    });

    it("edits a name and symbol, moves the default, and never deactivates the default", async () => {
      const [aed] = await q(`SELECT version FROM nzi_console.currencies WHERE organisation_id = $1 AND code = 'AED'`, [NZI]);
      const edited = await updateCurrency(database.pool, { code: "AED", name: "UAE dirham", symbol: "Dh", expectedVersion: aed.version }, context("ada", "admin"));
      assert.equal(edited.data.symbol, "Dh");
      const [gbp] = await q(`SELECT version FROM nzi_console.currencies WHERE organisation_id = $1 AND code = 'GBP'`, [NZI]);
      await assert.rejects(deactivateCurrency(database.pool, { code: "GBP", expectedVersion: gbp.version }, context("ada", "admin", NZI, "no")), /Command validation failed/);
      const moved = await setDefaultCurrency(database.pool, { code: "EUR", expectedVersion: 1 }, context("ada", "admin", NZI, "Invoicing in euros now"));
      assert.deepEqual([moved.data.isDefault, moved.data.previousDefault], [true, "GBP"]);
      const back = (await q(`SELECT version FROM nzi_console.currencies WHERE organisation_id = $1 AND code = 'GBP'`, [NZI]))[0].version;
      await setDefaultCurrency(database.pool, { code: "GBP", expectedVersion: back }, context("ada", "admin", NZI, "Back to sterling"));
      const page = await withTenantRead(database.pool, NZI, (db) => listCurrenciesPage(db, { search: "", filters: {}, sort: { key: "code", dir: "asc" }, page: 1, pageSize: 25 }));
      assert.deepEqual(page.rows.map((row) => [row.code, row.isDefault, row.inUse, row.provenance]), [
        ["AED", false, 1, "seeded"], ["EUR", false, 1, "seeded"], ["GBP", true, 1, "seeded"], ["USD", false, 0, "added"]]);
    });

    it("feeds currencySymbol: the directory is the organisation's own symbols", async () => {
      const directory = await withTenantRead(database.pool, NZI, (db) => readCurrencyDirectory(db, NZI));
      setCurrencyDirectory(directory);
      try {
        assert.deepEqual(["GBP", "AED", "EUR", "USD", "CHF"].map(currencySymbol), ["£", "Dh", "€", "$", "CHF"]);
      } finally { setCurrencyDirectory(null); }
    });
  });

  describe("client.update validates the currency (E-Q3)", () => {
    const update = async (clientId: string, currency: string, actorRole: StaffRole = "admin") => {
      const [row] = await q(`SELECT version, name FROM nzi_console.clients WHERE client_id = $1`, [clientId]);
      return updateClient(database.pool, { clientId, expectedVersion: row.version, name: row.name, status: "active", sector: "Manufacturing", location: "Leeds, UK", owner: "Ada Admin", currency }, context("ada", actorRole));
    };

    it("lets a held currency stand, and a change to an active one through", async () => {
      await update("c-uae", "AED");
      await update("c-eur", "USD");
      assert.equal((await q(`SELECT currency FROM nzi_console.clients WHERE client_id = 'c-eur'`))[0].currency, "USD");
    });

    it("refuses a currency the organisation does not hold, or has deactivated — and \"UAE\"", async () => {
      await assert.rejects(update("c-gbp", "JPY"), (error: Error & { issues?: Array<{ code: string }> }) => error.issues?.[0]?.code === "CURRENCY_UNKNOWN");
      await assert.rejects(update("c-gbp", "UAE"), /Command validation failed/);
      const [eur] = await q(`SELECT version FROM nzi_console.currencies WHERE organisation_id = $1 AND code = 'EUR'`, [NZI]);
      await deactivateCurrency(database.pool, { code: "EUR", expectedVersion: eur.version }, context("ada", "admin", NZI, "No euro clients any more"));
      await assert.rejects(update("c-gbp", "EUR"), (error: Error & { issues?: Array<{ code: string }> }) => error.issues?.[0]?.code === "CURRENCY_INACTIVE");
    });

    it("still lets a client already holding a deactivated currency be edited (R3)", async () => {
      await q(`UPDATE nzi_console.clients SET currency = 'EUR' WHERE client_id = 'c-eur'`);
      await update("c-eur", "EUR");
    });
  });
});
