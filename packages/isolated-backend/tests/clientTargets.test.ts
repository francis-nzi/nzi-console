// NZC-072 / NZC-068 — the forward targets: versioned, stamped with the benchmark in force,
// gated on target.edit, and held rather than silently restated when the baseline moves.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandGrantForRole, type StaffRole } from "@nzi/contracts";
import { AuthorizationError, CommandValidationError, getClientTargets, setClientTargets, VersionConflictError } from "../src/index";
import { withAccess } from "./support/access";

type Call = { sql: string; values?: readonly unknown[] };
const context = (key: string, role: StaffRole = "consultant", extra: { reason?: string } = {}) => ({
  organisationId: "org-a", actorId: "consultant-a", principal: "staff" as const, idempotencyKey: key, correlationId: `corr-${key}`,
  grant: commandGrantForRole(role, "org-a", "consultant-a"), ...(extra.reason ? { reason: extra.reason } : {}),
});

const baselineRow = (over: Record<string, unknown> = {}) => ({
  baseline_period_start: "2023-04-01", baseline_total_tco2e: "1842", baseline_scope1_tco2e: "120", baseline_scope2_tco2e: "400", baseline_scope3_tco2e: "1322", ...over,
});
const targetRow = (over: Record<string, unknown> = {}) => ({
  version: 1, near_term_year: 2030, near_term_pct: "50", net_zero_year: 2045, net_zero_pct: "90",
  scope1_year: null, scope1_pct: null, scope2_year: null, scope2_pct: null, scope3_year: null, scope3_pct: null,
  benchmark_year: 2023, benchmark_total_tco2e: "1842", benchmark_scope1_tco2e: "120", benchmark_scope2_tco2e: "400", benchmark_scope3_tco2e: "1322",
  benchmark_source: "client-record", benchmark_ref: null, reason: null, restated_benchmark: false,
  set_by: "consultant-a", set_at: "2026-09-01T10:00:00.000Z", ...over,
});

function pool(calls: Call[], options: { baseline?: Record<string, unknown> | null; current?: Record<string, unknown> | null } = {}) {
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("baseline_period_start,baseline_total_tco2e")) return { rows: options.baseline === null ? [] : [options.baseline ?? baselineRow()] };
      if (sql.includes("FROM nzi_console.client_targets")) return { rows: options.current === undefined ? [] : options.current === null ? [] : [options.current] };
      return { rows: [] };
    },
    release() {},
  };
  return withAccess({ connect: async () => client } as never, { ownerUserId: "consultant-a" });
}

const input = (over: Record<string, unknown> = {}) => ({
  clientId: "client-a", expectedVersion: 0,
  nearTerm: { year: 2030, pct: 50 }, netZero: { year: 2045, pct: 90 },
  scope1: { year: null, pct: null }, scope2: { year: null, pct: null }, scope3: { year: null, pct: null },
  ...over,
});

describe("setting the forward targets", () => {
  it("writes version 1 stamped with the benchmark in force — never a typed-in benchmark", async () => {
    const calls: Call[] = [];
    const result = await setClientTargets(pool(calls), input(), context("targets-1"));
    assert.equal(result.data.version, 1);
    assert.equal(result.data.benchmarkYear, 2023);
    const insert = calls.find((call) => call.sql.includes("INSERT INTO nzi_console.client_targets"))!;
    assert.equal(insert.values?.[2], 1, "version");
    assert.deepEqual(insert.values?.slice(3, 7), [2030, 50, 2045, 90]);
    assert.deepEqual(insert.values?.slice(13, 15), [2023, 1842], "the benchmark year and total are stamped from the baseline");
    assert.equal(insert.values?.[21], false, "not a restatement");
    assert.ok(calls.some((call) => call.sql.includes("INSERT INTO nzi_console.audit_events") && call.values?.[4] === "client_targets_set"));
  });

  it("appends the next version rather than editing the one in force", async () => {
    const calls: Call[] = [];
    const result = await setClientTargets(pool(calls, { current: targetRow() }), input({ expectedVersion: 1, nearTerm: { year: 2032, pct: 60 } }), context("targets-2"));
    assert.equal(result.data.version, 2);
    assert.ok(!calls.some((call) => /UPDATE nzi_console\.client_targets|DELETE/i.test(call.sql)), "targets are append-only");
  });

  it("refuses a stale expected version", async () => {
    await assert.rejects(() => setClientTargets(pool([], { current: targetRow({ version: 3 }) }), input({ expectedVersion: 1 }), context("targets-stale")), VersionConflictError);
  });

  it("asks for the baseline first — a target is a reduction against something", async () => {
    await assert.rejects(
      () => setClientTargets(pool([], { baseline: baselineRow({ baseline_period_start: null }) }), input(), context("targets-no-baseline")),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "BASELINE_REQUIRED"),
    );
  });

  it("refuses a target year that does not come after the benchmark", async () => {
    await assert.rejects(
      () => setClientTargets(pool([], {}), input({ nearTerm: { year: 2023, pct: 50 } }), context("targets-early")),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "AFTER_BENCHMARK"),
    );
  });

  it("is gated on target.edit", async () => {
    for (const role of ["reviewer", "finance", "viewer"] as const) {
      await assert.rejects(
        () => setClientTargets(pool([], {}), input(), context(`targets-${role}`, role)),
        (error: unknown) => error instanceof AuthorizationError && error.permission === "target.edit",
        role,
      );
    }
  });
});

describe("a re-baseline holds the targets (NZC-068)", () => {
  // The stored targets were stamped against FY23 · 1842; the baseline in force has moved.
  const moved = { current: targetRow(), baseline: baselineRow({ baseline_total_tco2e: "1950" }) };

  it("refuses to restate them onto the new benchmark unless that is asked for", async () => {
    await assert.rejects(
      () => setClientTargets(pool([], moved), input({ expectedVersion: 1 }), context("held")),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "BENCHMARK_MOVED"),
    );
  });

  it("needs a reason even when the restatement is asked for", async () => {
    await assert.rejects(
      () => setClientTargets(pool([], moved), input({ expectedVersion: 1, restateAgainstBenchmark: true }), context("held-no-reason")),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "REASON_REQUIRED"),
    );
  });

  it("records the restatement as its own governed event when it is made deliberately", async () => {
    const calls: Call[] = [];
    const result = await setClientTargets(pool(calls, moved), input({ expectedVersion: 1, restateAgainstBenchmark: true }), context("restate", "consultant", { reason: "Base year restated after the HQ relocation" }));
    assert.equal(result.data.restatedBenchmark, true);
    const insert = calls.find((call) => call.sql.includes("INSERT INTO nzi_console.client_targets"))!;
    assert.equal(insert.values?.[14], 1950, "stamped against the new benchmark");
    assert.equal(insert.values?.[21], true);
    assert.equal(insert.values?.[20], "Base year restated after the HQ relocation");
    const governed = calls.find((call) => call.sql.includes("INSERT INTO nzi_console.audit_events") && call.values?.[4] === "client_targets_restated")!;
    assert.ok(governed, "the restatement is audited in its own right");
    assert.deepEqual(JSON.parse(String(governed.values?.[10])), { benchmarkYear: 2023, benchmarkTotalTco2e: 1842 });
    assert.deepEqual(JSON.parse(String(governed.values?.[9])), { benchmarkYear: 2023, benchmarkTotalTco2e: 1950 });
  });

  it("sets the first targets against a moved benchmark without ceremony — there is nothing held yet", async () => {
    const calls: Call[] = [];
    await setClientTargets(pool(calls, { baseline: baselineRow({ baseline_total_tco2e: "1950" }) }), input(), context("first"));
    assert.ok(calls.some((call) => call.sql.includes("INSERT INTO nzi_console.client_targets")));
  });
});

describe("reading the targets back", () => {
  const read = (rows: Array<Record<string, unknown>>, benchmarkInForce: { year: number; totalTco2e: number } | null, actuals: Array<{ year: number; tco2e: number }> = []) => {
    const db = { async query() { return { rows } as never; } };
    return getClientTargets(db as never, "client-a", {
      benchmarkInForce: benchmarkInForce ? { ...benchmarkInForce, scopes: {}, source: "client-record" as const, reference: null } : null,
      actuals: actuals.map((actual) => ({ ...actual, snapshotId: "snap", jobNumber: "J000712" })),
    });
  };

  it("says there are no targets rather than showing zeros", async () => {
    const targets = await read([], { year: 2023, totalTco2e: 1842 });
    assert.equal(targets.model, null);
    assert.equal(targets.version, 0);
    assert.deepEqual(targets.trajectory, []);
    assert.deepEqual(targets.gaps, []);
    assert.equal(targets.latestGap, null);
  });

  it("derives the trajectory and the gap from the stored model", async () => {
    const targets = await read([targetRow()], { year: 2023, totalTco2e: 1842 }, [{ year: 2024, tco2e: 1500 }]);
    assert.deepEqual(targets.model?.nearTerm, { year: 2030, pct: 50 });
    assert.deepEqual(targets.trajectory.map((point) => point.kind), ["benchmark", "near-term", "net-zero"]);
    assert.equal(targets.gaps[0]?.year, 2024);
    assert.equal(targets.gaps[0]?.status, "ahead");
    assert.equal(targets.latestGap?.year, 2024);
    assert.equal(targets.benchmarkStale, false);
  });

  it("flags targets standing on a benchmark that has since been restated", async () => {
    const targets = await read([targetRow()], { year: 2023, totalTco2e: 1950 });
    assert.equal(targets.benchmarkStale, true);
    assert.equal(targets.benchmark?.totalTco2e, 1842, "they still measure against the benchmark they were set with");
    assert.equal(targets.benchmarkInForce?.totalTco2e, 1950);
  });
});
