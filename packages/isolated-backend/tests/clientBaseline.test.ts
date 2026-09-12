import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CommandValidationError, recalculateClientBaseline, setClientBaseline } from "../src/index";

const context = { organisationId: "org-a", actorId: "staff-a", principal: "staff" as const, idempotencyKey: "bl-1", correlationId: "corr-1" };
const base = {
  clientId: "client-a", periodStart: "2022-01-01", periodEnd: "2022-12-31",
  source: "declared" as const, effectiveFrom: "2022-01-01",
  figures: { scope1: 10, scope2: 20, scope3: 70, total: 100 },
};

type Call = { sql: string; values?: readonly unknown[] };
const pool = (calls: Call[], rows: Record<string, unknown[]>) => ({
  connect: async () => ({
    async query(sql: string, values?: readonly unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: [] };
      if (sql.includes("SELECT baseline_id FROM nzi_console.client_baselines")) return { rows: rows.existing ?? [] };
      if (sql.includes("UPDATE nzi_console.client_baselines SET superseded_at")) return { rows: rows.superseded ?? [] };
      return { rows: [] };
    },
    release() {},
  }),
}) as never;

describe("client baseline commands (NZC-065 / NZC-068)", () => {
  it("inserts an initial baseline with kind 'initial' and no reason", async () => {
    const calls: Call[] = [];
    const result = await setClientBaseline(pool(calls, {}), base, context);
    assert.equal(result.data.kind, "initial");
    const insert = calls.find((c) => c.sql.includes("INSERT INTO nzi_console.client_baselines"));
    assert.ok(insert, "expected a baseline insert");
    assert.ok(insert!.values?.includes("initial"));
    assert.ok(insert!.values?.includes("declared"));
    assert.ok(calls.some((c) => c.sql.includes("INSERT INTO nzi_console.audit_events")));
  });

  it("refuses a second 'initial' baseline — re-basing must go through the governed path", async () => {
    await assert.rejects(
      () => setClientBaseline(pool([], { existing: [{ baseline_id: "bl-1" }] }), base, { ...context, idempotencyKey: "bl-dup" }),
      CommandValidationError,
    );
  });

  it("supersedes the prior record and inserts the new one, carrying the reason", async () => {
    const calls: Call[] = [];
    const result = await recalculateClientBaseline(
      pool(calls, { superseded: [{ baseline_id: "bl-old" }] }),
      { ...base, kind: "rebaseline", supersedesBaselineId: "bl-old", periodStart: "2024-01-01", periodEnd: "2024-12-31", effectiveFrom: "2024-01-01" },
      { ...context, idempotencyKey: "bl-recalc", reason: "Acquired Northwind Energy" },
    );
    assert.equal(result.data.kind, "rebaseline");
    const update = calls.find((c) => c.sql.includes("SET superseded_at"));
    assert.ok(update, "the prior baseline must be superseded, never overwritten");
    assert.ok(update!.sql.includes("superseded_at IS NULL"), "only an in-force record can be superseded");
    const insert = calls.find((c) => c.sql.includes("INSERT INTO nzi_console.client_baselines"));
    assert.ok(insert!.values?.includes("Acquired Northwind Energy"), "the reason is recorded on the new record");
    assert.ok(insert!.values?.includes("rebaseline"));
  });

  it("never updates the figures of an existing record — the table is append-only", async () => {
    const calls: Call[] = [];
    await recalculateClientBaseline(
      pool(calls, { superseded: [{ baseline_id: "bl-old" }] }),
      { ...base, kind: "recalculation", supersedesBaselineId: "bl-old" },
      { ...context, idempotencyKey: "bl-append", reason: "Methodology change" },
    );
    const writes = calls.filter((c) => c.sql.includes("nzi_console.client_baselines") && c.sql.includes("UPDATE"));
    assert.equal(writes.length, 1, "exactly one UPDATE, and only to stamp superseded_at");
    assert.ok(!writes[0]!.sql.includes("total_tco2e"), "an existing record's figures are never rewritten");
  });

  it("rejects replacing a baseline that is missing or already superseded", async () => {
    await assert.rejects(
      () => recalculateClientBaseline(
        pool([], { superseded: [] }),
        { ...base, kind: "rebaseline", supersedesBaselineId: "gone" },
        { ...context, idempotencyKey: "bl-missing", reason: "Acquisition" },
      ),
      CommandValidationError,
    );
  });
});
