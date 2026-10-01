import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { syntheticExtract, syntheticRows } from "./support/v7SyntheticExtract";
import { setDefaultCurrency, updateCurrency } from "../src/commercialLookups";
import type { V7Row, V7Table } from "../src/v7ClientExtract";
import { CURRENCIES_RUN_PREFIX, loadV7Currencies, planV7Currencies } from "../src/v7CurrenciesLoad";

/**
 * The v7 currencies import (admin Phase E1, `load:v7-currencies`): v7's two currency tables consolidated by ISO code into
 * one clean set — `currency_lookup` first, the legacy `currencies_lookup` filling gaps and adding its own codes — with
 * v7's "UAE" read as AED and no alias (E-Q2), no exchange rate (E-Q1). Reconciled onto 0145's seeded rows by code; R4
 * re-runs; a person's default and a person's edits stand. Planning is pure; the load runs as the application role.
 */
const ORG = "cur-load-org";
type Rows = ReturnType<typeof syntheticRows>;
const extract = (mutate?: (rows: Rows) => void): Partial<Record<V7Table, V7Row[]>> => { const rows = syntheticRows(); mutate?.(rows); return syntheticExtract(rows); };

describe("planning the currencies import (no database)", () => {
  const plan = planV7Currencies(extract());

  it("consolidates both tables by ISO code — the current one first, the legacy one filling gaps and adding its own", () => {
    assert.deepEqual(plan.values.map((value) => [value.code, value.name, value.symbol, value.isDefault, value.active]), [
      ["AED", "UAE Dirham", "د.إ", false, true],
      ["AUD", "Australian Dollar", "A$", false, false],
      ["CHF", "Swiss Franc", "CHF", false, true],
      ["EUR", "Euro", "€", false, true],
      ["GBP", "British Pound", "£", true, true],
      ["USD", "US Dollar", "$", false, true],
    ]);
    assert.equal(plan.refused, null);
    assert.deepEqual(Object.keys(plan.values.find((value) => value.code === "GBP")!.legacyValues).sort(), ["currencies_lookup", "currency_lookup"], "what each v7 table held");
    assert.ok(!JSON.stringify(plan.values).includes("exchange"), "no exchange rate (E-Q1)");
  });

  it("reads v7's \"UAE\" as AED, says so, and holds no \"UAE\"", () => {
    assert.ok(!plan.values.some((value) => value.code === "UAE"));
    assert.deepEqual(plan.corrections, ["currency_lookup: v7's \"UAE\" is read as AED (the country is not a currency)"]);
  });

  it("leaves out a code that is not ISO-shaped, and a second row for one code, and refuses two defaults", () => {
    const odd = planV7Currencies(extract((rows) => {
      rows.currency_lookup.push({ currency_id: "6", currency_code: "Pounds", currency_name: "Pounds", symbol: "£", is_default: "f", is_active: "t", sort_order: "60" });
      rows.currency_lookup.push({ currency_id: "7", currency_code: "AED", currency_name: "Dirham again", symbol: "AED", is_default: "f", is_active: "t", sort_order: "70" });
    }));
    assert.deepEqual(odd.skipped.map((skip) => [skip.table, skip.reason]), [
      ["currency_lookup", "not a three-letter ISO-4217 code"],
      ["currency_lookup", "a second row for AED; v7 row 5 is the one taken"],
    ]);
    const two = planV7Currencies(extract((rows) => { rows.currency_lookup[1]!.is_default = "t"; }));
    assert.match(two.refused ?? "", /2 default currencies \(EUR, GBP\)/);
  });
});

describe("loading the currencies import, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const context = (reason?: string): CommandContext => ({ organisationId: ORG, actorId: "ada", principal: "staff", idempotencyKey: `cur-load-${Math.random()}`, correlationId: "corr", ...(reason ? { reason } : {}), grant: commandGrantForRole("admin", ORG, "ada") });
  const held = async () => (await q(`SELECT code, name, symbol, is_default, active, source_system, legacy_db_id FROM nzi_console.currencies WHERE organisation_id = $1 ORDER BY code`, [ORG]));

  before(async () => {
    database = (await createDisposableDatabase("currenciesload"))!;
    // A new organisation: 0145 provisions GBP, the default. A client in dirhams, then the set seeded as 0145 would.
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, 'Currency Load Org')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, 'c-aed', 'Dirham Client', 'active', 'AED')`, [ORG]);
    await q(`SELECT nzi_console.provision_organisation_currencies($1, 'migration:0145')`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada Admin')`, [ORG]);
  });
  after(async () => { await database?.end(); });

  it("a dry run writes nothing", async () => {
    const before = await held();
    const outcome = await loadV7Currencies(database.pool, ORG, planV7Currencies(extract()), { commit: false });
    assert.deepEqual([outcome.inserted, outcome.stamped], [4, 2]);
    assert.deepEqual(await held(), before);
  });

  it("stamps 0145's rows with v7's values and inserts the rest; reports nothing held here only; audits the run", async () => {
    const outcome = await loadV7Currencies(database.pool, ORG, planV7Currencies(extract()), { commit: true, runId: `${CURRENCIES_RUN_PREFIX}first` });
    assert.deepEqual([outcome.inserted, outcome.stamped, outcome.updated, outcome.unchanged, outcome.conflicts.length], [4, 2, 0, 0, 0]);
    assert.deepEqual(outcome.hereOnly, []);
    assert.deepEqual(outcome.parity, { v7Active: 5, v7Inactive: 1, consoleActive: 5, consoleInactive: 1 });
    const rows = await held();
    assert.deepEqual(rows.map((row) => [row.code, row.name, row.symbol, row.is_default, row.active, row.legacy_db_id]), [
      ["AED", "UAE Dirham", "د.إ", false, true, "AED"], ["AUD", "Australian Dollar", "A$", false, false, "AUD"], ["CHF", "Swiss Franc", "CHF", false, true, "CHF"],
      ["EUR", "Euro", "€", false, true, "EUR"], ["GBP", "British Pound", "£", true, true, "GBP"], ["USD", "US Dollar", "$", false, true, "USD"],
    ]);
    assert.ok(rows.every((row) => row.source_system !== null));
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE action = 'currencies.imported' AND organisation_id = $1`, [ORG]))[0].n, 1);
  });

  it("re-run unchanged: nothing written", async () => {
    const outcome = await loadV7Currencies(database.pool, ORG, planV7Currencies(extract()), { commit: true, runId: `${CURRENCIES_RUN_PREFIX}second` });
    assert.deepEqual([outcome.inserted, outcome.stamped, outcome.updated, outcome.unchanged], [0, 0, 0, 6]);
  });

  it("R4: v7 changed and the row still as imported → v7 wins; v7 changed and edited here since → refused and reported", async () => {
    const [chf] = await q(`SELECT version FROM nzi_console.currencies WHERE organisation_id = $1 AND code = 'CHF'`, [ORG]);
    await updateCurrency(database.pool, { code: "CHF", name: "Swiss franc", symbol: "Fr.", expectedVersion: chf.version }, context());
    const changed = extract((rows) => {
      rows.currency_lookup[2]!.currency_name = "United States Dollar"; // USD: untouched here → v7 wins
      rows.currencies_lookup[3]!.symbol = "SFr"; // CHF: edited here since → refused
    });
    const outcome = await loadV7Currencies(database.pool, ORG, planV7Currencies(changed), { commit: true, runId: `${CURRENCIES_RUN_PREFIX}third` });
    assert.deepEqual([outcome.updated, outcome.conflicts], [1, ["CHF: changed in v7 since the last load, and edited here since"]]);
    const rows = await held();
    assert.equal(rows.find((row) => row.code === "USD")?.name, "United States Dollar");
    assert.equal(rows.find((row) => row.code === "CHF")?.symbol, "Fr.", "a person's edit stands");
  });

  it("a default a person chose stands against v7's", async () => {
    const [eur] = await q(`SELECT version FROM nzi_console.currencies WHERE organisation_id = $1 AND code = 'EUR'`, [ORG]);
    await setDefaultCurrency(database.pool, { code: "EUR", expectedVersion: eur.version }, context("We invoice in euros"));
    const outcome = await loadV7Currencies(database.pool, ORG, planV7Currencies(extract()), { commit: true, runId: `${CURRENCIES_RUN_PREFIX}fourth` });
    assert.ok(outcome.notes.some((note) => /the console's own default currency EUR stands; v7's default GBP is loaded as not the default/.test(note)), outcome.notes.join(" | "));
    const defaults = (await held()).filter((row) => row.is_default).map((row) => row.code);
    assert.deepEqual(defaults, ["EUR"]);
  });

  it("refuses a v7 with two defaults, writing nothing", async () => {
    const before = await held();
    const outcome = await loadV7Currencies(database.pool, ORG, planV7Currencies(extract((rows) => { rows.currency_lookup[1]!.is_default = "t"; })), { commit: true });
    assert.match(outcome.refused ?? "", /default currencies/);
    assert.deepEqual(await held(), before);
  });
});
