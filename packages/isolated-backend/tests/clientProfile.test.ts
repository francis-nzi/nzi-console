import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CommandValidationError, createClient, updateClient, VersionConflictError } from "../src/index";

const context = { organisationId: "org-a", actorId: "staff-a", principal: "staff" as const, idempotencyKey: "client-1", correlationId: "corr-1" };
const identity = { name: "8 Doors Distillery", status: "active" as const, sector: "Food and Drink", location: "Wick, UK", owner: "D. Hawes" };
const profile = {
  portfolio: "NZN", website: "https://www.8doorsdistillery.com/", companyRegistration: "SC629354",
  financialYearEndMonth: 12, currency: "GBP", dataReportingFrequency: "annual" as const,
  netZeroTargetYear: 2045, netZeroTargetReductionPct: 90,
  baselinePeriodStart: "2022-08-01", baselinePeriodEnd: "2023-07-31",
  registeredCity: "Wick", registeredPostcode: "KW1 4YR", billingSameAsRegistered: true,
  reportingFrameworks: ["SECR"], primaryScope3Categories: ["3.1", "3.6"],
};

type Call = { sql: string; values?: readonly unknown[] };
const pool = (calls: Call[], updateRows: Array<{ version: number }>, currentRows: Array<{ version: number }> = []) => ({
  connect: async () => ({
    async query(sql: string, values?: readonly unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: [] };
      if (sql.includes("UPDATE nzi_console.clients")) return { rows: updateRows };
      if (sql.includes("SELECT version FROM nzi_console.clients")) return { rows: currentRows };
      return { rows: [] };
    },
    release() {},
  }),
}) as never;

describe("client profile persistence (NZC-064)", () => {
  it("writes every profile column on create, with one placeholder per value", async () => {
    const calls: Call[] = [];
    await createClient(pool(calls, []), { ...identity, ...profile }, context);
    const insert = calls.find((call) => call.sql.includes("INSERT INTO nzi_console.clients"));
    assert.ok(insert, "expected a client insert");
    const columns = insert!.sql.slice(insert!.sql.indexOf("(") + 1, insert!.sql.indexOf(")")).split(",").length;
    const placeholders = new Set(insert!.sql.match(/\$\d+/g) ?? []).size;
    // 3 literal columns (member_since, completeness_percent, next_report_due_label) are inlined, not bound.
    assert.equal(columns, placeholders + 3);
    assert.equal(insert!.values?.length, placeholders);
    assert.ok(insert!.values?.includes("https://www.8doorsdistillery.com/"));
    assert.ok(insert!.values?.includes(2045));
    assert.deepEqual(insert!.values?.at(-3), ["SECR"]);
  });

  it("defaults reporting frequency, currency and billing flag when the wizard skips them", async () => {
    const calls: Call[] = [];
    await createClient(pool(calls, []), identity, context);
    const insert = calls.find((call) => call.sql.includes("INSERT INTO nzi_console.clients"));
    assert.ok(insert!.values?.includes("annual"));
    assert.ok(insert!.values?.includes("GBP"));
    assert.ok(insert!.values?.includes(true));
    // An unset contact reads as empty text, never null, so the read model stays string-typed.
    assert.equal(insert!.values?.[7], "");
  });

  it("bumps the version and guards the expected one on update", async () => {
    const calls: Call[] = [];
    const result = await updateClient(pool(calls, [{ version: 4 }]), { clientId: "client-a", expectedVersion: 3, ...identity, ...profile }, context);
    assert.equal(result.data.version, 4);
    const update = calls.find((call) => call.sql.includes("UPDATE nzi_console.clients"));
    assert.ok(update!.sql.includes("version=version+1"));
    assert.ok(update!.sql.includes("AND version=$3"));
    assert.equal(update!.values?.[2], 3);
    // Highest placeholder must equal the bound value count — an off-by-one here silently writes the wrong column.
    const highest = Math.max(...(update!.sql.match(/\$(\d+)/g) ?? []).map((token) => Number(token.slice(1))));
    assert.equal(highest, update!.values?.length);
  });

  it("raises a version conflict when the record moved on, and not-found when it never existed", async () => {
    const stale = { clientId: "client-a", expectedVersion: 2, ...identity };
    await assert.rejects(() => updateClient(pool([], [], [{ version: 5 }]), stale, context), VersionConflictError);
    await assert.rejects(() => updateClient(pool([], [], []), stale, { ...context, idempotencyKey: "client-missing" }), CommandValidationError);
  });
});
