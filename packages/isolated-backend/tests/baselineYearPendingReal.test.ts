import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext, type CommandInputMap, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { getBaselineYearState, getBenchmarkInForce, getClientTargets, getJobPathwayTarget } from "../src/clientTargetRecords";
import { setClientTargets } from "../src/clientTargets";
import { useSnapshotAsBaseline } from "../src/clientBaselineSnapshot";
import { moveClientBaselinePeriod } from "../src/clientBaselinePeriod";
import { carryJobPathwayTargets } from "../src/jobPathwayCarry";
import { previewJobUpdate, updateJob } from "../src/jobUpdate";
import { calculateScopeRow, createJob, updateClient } from "../src/postgresCommands";
import { withTenantRead } from "../src/postgres";
import { listAllClients } from "../src/readModels";

/**
 * BRIEF-baseline-year-and-pending-targets (ruled 25 Nov 2026), migration 0238, against a real database:
 * - a baseline year with no figures is stored and read as pending — never "no baseline", never 0;
 * - a percentage target is accepted against it, its tCO₂e is pending, and once figures are set the derived tCO₂e is
 *   baseline × (1 − %), the version not held as stale;
 * - "use the job's figures" writes the snapshot's scope totals, audited citing the snapshot, and a hand edit clears the citation;
 * - an explicit zero needs its confirm;
 * - changing figures later is the governed re-baseline, the prior kept; adding the first figures is not;
 * - Addendum B.3/B.4: a period move over recorded data needs a reason, re-chooses the datasets per calendar year, re-prices
 *   the rows (previewed per scope, run and rolled back), is refused once figures are issued, and reports a baseline-year job.
 */
type Issue = { field: string; code: string };
const refused = (code: string) => (error: { issues?: Issue[] }) => error.issues?.some((item) => item.code === code) === true;

describe("a baseline year before its figures, and targets while they are pending", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "by-org-a";
  let database: DisposableDatabase;
  let keys = 0;
  const context = (reason?: string, role: StaffRole = "admin"): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: `${role}-by`, principal: "staff", idempotencyKey: `by-${keys}`, correlationId: `corr-by-${keys}`,
      ...(reason ? { reason } : {}), grant: commandGrantForRole(role, ORG, `${role}-by`) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const read = <T>(work: (db: import("../src/postgres").Queryable) => Promise<T>) => withTenantRead(database.pool, ORG, work);
  /** client.update exactly as the Set baseline drawer sends it: the whole record as read, with the baseline on top. */
  const saveBaseline = async (clientId: string, baseline: Partial<CommandInputMap["client.update"]>, reason?: string) => {
    const [client] = await read((db) => listAllClients(db, clientId));
    return updateClient(database.pool, {
      clientId, expectedVersion: client!.version, name: client!.name, status: client!.status, sector: client!.sector, location: client!.location, owner: client!.owner,
      ...client!.profile, ...baseline,
    } as CommandInputMap["client.update"], context(reason));
  };
  const targets = (clientId: string) => read(async (db) => getClientTargets(db, clientId, { benchmarkInForce: await getBenchmarkInForce(db, clientId), actuals: [], baselineYear: await getBaselineYearState(db, clientId) }));
  const targetInput = (clientId: string, expectedVersion: number) => ({
    clientId, expectedVersion, nearTerm: { year: 2030, pct: 50 }, netZero: { year: 2050, pct: 90 },
    scope1: { year: null, pct: null }, scope2: { year: null, pct: null }, scope3: { year: null, pct: null },
  }) as CommandInputMap["client.targets.set"];
  const changeEvents = (clientId: string) => q(`SELECT before_json, after_json, reason FROM nzi_console.baseline_change_events WHERE client_id = $1 ORDER BY changed_at`, [clientId]);

  before(async () => {
    database = (await createDisposableDatabase("baselineyear"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    for (const role of ["admin", "consultant"]) {
      await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, $2, $3, 'active', $2)`, [ORG, `${role}-by`, role]);
    }
    for (const id of ["c-pending", "c-zero", "c-snap", "c-move"]) {
      await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, sector, location, owner_name) VALUES ($1, $2, $2, 'active', 'Services', 'Leeds', 'Ada')`, [ORG, id]);
    }
  });
  after(async () => { await database?.end(); });

  it("stores a baseline year with no figures and reads it as pending — not as no baseline, and no number", async () => {
    await saveBaseline("c-pending", { baselinePeriodStart: "2025-05-01", baselinePeriodEnd: "2026-04-30" });
    const state = await read((db) => getBaselineYearState(db, "c-pending"));
    assert.deepEqual([state?.year, state?.periodStart, state?.periodEnd, state?.pending], [2025, "2025-05-01", "2026-04-30", true]);
    assert.equal(await read((db) => getBenchmarkInForce(db, "c-pending")), null, "no benchmark — no reader can measure against a number");
    assert.deepEqual(await changeEvents("c-pending"), [], "setting the year is the initial baseline, not a re-baseline");
  });

  it("accepts percentage targets against it: the percentage is the record, the tCO₂e pending, nothing drawn", async () => {
    const saved = await setClientTargets(database.pool, targetInput("c-pending", 0), context());
    assert.deepEqual([saved.data.benchmarkYear, saved.data.benchmarkPending], [2025, true]);
    const [row] = await q(`SELECT benchmark_year, benchmark_total_tco2e, benchmark_pending, near_term_pct::float8 AS pct FROM nzi_console.client_targets WHERE client_id = 'c-pending'`);
    assert.deepEqual(row, { benchmark_year: 2025, benchmark_total_tco2e: null, benchmark_pending: true, pct: 50 }, "no tCO₂e stored as if it had been entered");
    const model = await targets("c-pending");
    assert.equal(model.benchmarkPending, true);
    assert.deepEqual(model.milestones.map((m) => [m.kind, m.tco2e]), [["near-term", null], ["net-zero", null]], "pending, never 0");
    assert.deepEqual([model.trajectory, model.gaps, model.latestGap], [[], [], null]);
    assert.equal((await read((db) => getJobPathwayTarget(db, "nope"))), null);
  });

  it("works the tCO₂e out once the figures are set — baseline × (1 − %) — without a re-baseline and without holding the targets", async () => {
    await saveBaseline("c-pending", { baselineScope1Tco2e: 100, baselineScope2Tco2e: 200, baselineScope3Tco2e: 700 });
    assert.deepEqual(await changeEvents("c-pending"), [], "adding the first figures is not the governed re-baseline");
    const model = await targets("c-pending");
    assert.deepEqual([model.benchmarkPending, model.benchmarkStale], [false, false]);
    const round = (value: number | null) => value === null ? null : Math.round(value * 1000) / 1000;
    assert.deepEqual(model.milestones.map((m) => [m.kind, round(m.tco2e)]), [["near-term", 500], ["net-zero", 100]]);
    assert.deepEqual(model.trajectory.map((p) => [p.year, round(p.tco2e)]), [[2025, 1000], [2030, 500], [2050, 100]]);
    assert.equal((await read((db) => getBaselineYearState(db, "c-pending")))?.pending, false);
  });

  it("makes changing the figures later the governed re-baseline, with the prior kept", async () => {
    await assert.rejects(saveBaseline("c-pending", { baselineScope1Tco2e: 150 }), refused("REASON_REQUIRED"));
    await saveBaseline("c-pending", { baselineScope1Tco2e: 150 }, "Boiler meter re-read");
    const [event] = await changeEvents("c-pending");
    assert.deepEqual([event?.before_json, event?.after_json, event?.reason], [{ baselineScope1Tco2e: 100 }, { baselineScope1Tco2e: 150 }, "Boiler meter re-read"]);
    const audit = await q(`SELECT action FROM nzi_console.audit_events WHERE client_id = 'c-pending' AND action = 'client_rebaselined'`);
    assert.equal(audit.length, 1);
  });

  it("refuses a 0 without its confirm — 0 is not pending — and accepts it with one", async () => {
    await assert.rejects(saveBaseline("c-zero", { baselinePeriodStart: "2025-01-01", baselinePeriodEnd: "2025-12-31", baselineScope1Tco2e: 0, baselineScope2Tco2e: 40 }),
      (error: { issues?: Issue[] }) => error.issues?.some((item) => item.code === "ZERO_NOT_CONFIRMED" && item.field === "baselineScope1Tco2e") === true);
    await saveBaseline("c-zero", { baselinePeriodStart: "2025-01-01", baselinePeriodEnd: "2025-12-31", baselineScope1Tco2e: 0, baselineScope2Tco2e: 40, baselineZeroConfirmed: ["baselineScope1Tco2e"] });
    const [row] = await q(`SELECT baseline_scope1_tco2e::float8 AS s1 FROM nzi_console.clients WHERE client_id = 'c-zero'`);
    assert.equal(row.s1, 0);
    const [audit] = await q(`SELECT after_json FROM nzi_console.audit_events WHERE client_id = 'c-zero' AND action = 'client_updated' ORDER BY occurred_at DESC LIMIT 1`);
    assert.ok(audit, "the save is audited");
  });

  it("uses the baseline year's job figures: the snapshot's scope totals, audited citing the snapshot; a hand edit clears the citation", async () => {
    await saveBaseline("c-snap", { baselinePeriodStart: "2025-05-01", baselinePeriodEnd: "2026-04-30" });
    const job = (await createJob(database.pool, { clientId: "c-snap", family: "crp", title: "CRP 2025/26", workflowStage: "Setup", owner: "Ada", startDate: "2025-05-01", dueDate: "2026-09-30",
      reportingPeriodStart: "2025-05-01", reportingPeriodEnd: "2026-04-30" }, context())).data;
    const payload = { jobNumber: job.jobNumber, client: "c-snap", reportingYear: 2026, measurements: [
      { rowId: "r1", scope: "1", tco2e: 10.5 }, { rowId: "r2", scope: "1", tco2e: 2 }, { rowId: "r3", scope: "3", tco2e: 5 }] };
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by)
             VALUES ($1, 'snap-1', $2, 1, 1, $3, $4::jsonb, 'reviewer')`, [ORG, job.jobId, `sha256:${"a".repeat(64)}`, JSON.stringify(payload)]);
    const state = await read((db) => getBaselineYearState(db, "c-snap"));
    assert.deepEqual(state?.supplyingJob, { jobId: job.jobId, jobNumber: job.jobNumber, snapshotId: "snap-1" }, "the year's job, offered with its reviewed snapshot");

    const [client] = await read((db) => listAllClients(db, "c-snap"));
    const used = await useSnapshotAsBaseline(database.pool, { clientId: "c-snap", expectedVersion: client!.version, snapshotId: "snap-1" }, context());
    assert.deepEqual([used.data.scope1Tco2e, used.data.scope2Tco2e, used.data.scope3Tco2e, used.data.totalTco2e, used.data.rebaselined], [12.5, null, 5, 17.5, false],
      "a scope with no rows stays pending, never 0");
    const [row] = await q(`SELECT baseline_scope1_tco2e::float8 AS s1, baseline_scope2_tco2e AS s2, baseline_total_tco2e::float8 AS total, baseline_snapshot_id FROM nzi_console.clients WHERE client_id = 'c-snap'`);
    assert.deepEqual(row, { s1: 12.5, s2: null, total: 17.5, baseline_snapshot_id: "snap-1" });
    const [audit] = await q(`SELECT after_json FROM nzi_console.audit_events WHERE client_id = 'c-snap' AND action = 'client_baseline_from_snapshot'`);
    assert.equal(audit?.after_json.snapshotId, "snap-1", "the audit cites the snapshot");
    assert.equal((await read((db) => getBaselineYearState(db, "c-snap")))?.figuresFrom?.snapshotId, "snap-1");

    // Typing figures in stays possible — a re-baseline now — and the baseline no longer cites the snapshot.
    await saveBaseline("c-snap", { baselineScope2Tco2e: 3, baselineTotalTco2e: 20.5 }, "Scope 2 confirmed by the supplier");
    assert.equal((await q(`SELECT baseline_snapshot_id FROM nzi_console.clients WHERE client_id = 'c-snap'`))[0].baseline_snapshot_id, null);
  });

  it("refuses a snapshot of a job whose period is not the baseline period", async () => {
    const job = (await createJob(database.pool, { clientId: "c-snap", family: "crp", title: "CRP 2024", workflowStage: "Setup", owner: "Ada", startDate: "2024-01-01", dueDate: "2025-06-30",
      reportingPeriodStart: "2024-01-01", reportingPeriodEnd: "2024-12-31" }, context())).data;
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by)
             VALUES ($1, 'snap-2024', $2, 1, 1, $3, $4::jsonb, 'reviewer')`, [ORG, job.jobId, `sha256:${"b".repeat(64)}`, JSON.stringify({ jobNumber: job.jobNumber, client: "c-snap", reportingYear: 2024, measurements: [{ scope: "1", tco2e: 1 }] })]);
    const [client] = await read((db) => listAllClients(db, "c-snap"));
    await assert.rejects(useSnapshotAsBaseline(database.pool, { clientId: "c-snap", expectedVersion: client!.version, snapshotId: "snap-2024" }, context("x")), refused("NOT_BASELINE_PERIOD"));
  });

  describe("Addendum A: one baseline, on the client", () => {
    const jobTarget = (jobId: string, baselineYear: number, tco2e: number, interimYear: number, pct: number) => q(
      `INSERT INTO nzi_console.job_emissions_targets (organisation_id, job_id, baseline_year, baseline_tco2e, interim_year, interim_reduction_percent, net_zero_year, version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, 2050, 1, 'staff')`, [ORG, jobId, baselineYear, tco2e, interimYear, pct]);
    const crp = async (clientId: string) => (await createJob(database.pool, { clientId, family: "crp", title: "CRP", workflowStage: "Setup", owner: "Ada", startDate: "2024-01-01", dueDate: "2025-06-30",
      reportingPeriodStart: "2024-01-01", reportingPeriodEnd: "2024-12-31" }, context())).data;

    it("carries a job's pathway values onto the client (dry run first), lists conflicts, and the job then reads the client's", async () => {
      for (const id of ["c-carry", "c-clash"]) await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, sector, location, owner_name) VALUES ($1, $2, $2, 'active', 'Services', 'Leeds', 'Ada')`, [ORG, id]);
      await saveBaseline("c-carry", { baselinePeriodStart: "2024-01-01", baselinePeriodEnd: "2024-12-31" });
      await saveBaseline("c-clash", { baselinePeriodStart: "2024-01-01", baselinePeriodEnd: "2024-12-31", baselineTotalTco2e: 55 });
      const carryJob = await crp("c-carry"), clashJob = await crp("c-clash");
      await jobTarget(carryJob.jobId, 2024, 80, 2030, 40);
      await jobTarget(clashJob.jobId, 2024, 70, 2030, 40);
      assert.equal((await read((db) => getJobPathwayTarget(db, carryJob.jobId)))?.target, null, "the job reads the client — pending — never its own row");

      const dry = await carryJobPathwayTargets(database.pool, ORG, { commit: false });
      assert.equal(dry.committed, false);
      assert.equal((await read((db) => getBenchmarkInForce(db, "c-carry"))), null, "a dry run writes nothing");

      const run = await carryJobPathwayTargets(database.pool, ORG, { commit: true });
      const carried = run.carried.find((entry) => entry.clientId === "c-carry");
      assert.deepEqual(carried?.items.map((item) => item.what), ["baseline total", "near-term", "net zero"]);
      assert.equal(carried?.defaultedNetZeroPct, true, "a net-zero year with no % takes the methodology minimum, and says so");
      assert.ok(run.conflicts.some((entry) => entry.clientId === "c-clash" && entry.what === "baseline total"), JSON.stringify(run.conflicts));

      const pathway = await read((db) => getJobPathwayTarget(db, carryJob.jobId));
      assert.deepEqual(pathway?.target && [pathway.target.baselineYear, pathway.target.baselineTco2e, pathway.target.interimYear, pathway.target.interimReductionPercent, pathway.target.netZeroYear],
        [2024, 80, 2030, 40, 2050]);
    });
  });

  describe("Addendum B.3/B.4: a period move over recorded data", () => {
    let jobId = "";
    const dataset = (id: string, year: number) => q(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id, dataset_id, name, version, valid_from, valid_to, country_code, status, source_name, licence)
      VALUES ($1, $2, $2, $3, $4, $5, 'GB', 'active', 'DESNZ', 'test')`, [ORG, id, `v${year}`, `${year}-01-01`, `${year}-12-31`]);
    const factor = (datasetId: string, kg: number) => q(`INSERT INTO nzi_console.emission_factors (organisation_id, dataset_id, factor_id, label, activity_unit, kgco2e_per_unit, scopes) VALUES ($1, $2, 'gas', 'Natural gas', 'kWh', $3, ARRAY['1'])`, [ORG, datasetId, kg]);
    const row = () => q(`SELECT dataset_id, calculated_tco2e::float8 AS calc, version FROM nzi_console.job_scope_rows WHERE scope_row_id = 'live-gas'`).then((rows) => rows[0]);

    before(async () => {
      await q(`UPDATE nzi_console.emission_factor_datasets SET status = 'superseded' WHERE organisation_id = $1`, [ORG]);
      await dataset("uk-ghg-gb-2025", 2025); await dataset("uk-ghg-gb-2026", 2026);
      await factor("uk-ghg-gb-2025", 0.2); await factor("uk-ghg-gb-2026", 0.1);
      await saveBaseline("c-move", { baselinePeriodStart: "2025-01-01", baselinePeriodEnd: "2025-12-31" });
      jobId = (await createJob(database.pool, { clientId: "c-move", family: "crp", title: "CRP", workflowStage: "Setup", owner: "Ada", startDate: "2025-01-01", dueDate: "2026-06-30",
        reportingPeriodStart: "2025-01-01", reportingPeriodEnd: "2025-12-31" }, context())).data.jobId;
      await q(`INSERT INTO nzi_console.job_scope_rows (organisation_id, scope_row_id, job_id, scope, source_label, report_label, level_1, level_2, factor_source, dataset_id, factor_id, quantity, unit)
               VALUES ($1, 'live-gas', $2, '1', 'Gas', 'Gas', 'Scope 1', 'Fuels', 'dataset', 'uk-ghg-gb-2025', 'gas', 1000, 'kWh')`, [ORG, jobId]);
      await calculateScopeRow(database.pool, { jobId, rowId: "live-gas", expectedVersion: (await row()).version }, context());
    });

    it("needs a reason, previews the totals per scope before and after — run and rolled back — and writes nothing", async () => {
      assert.equal((await row()).calc, 0.2);
      const version = (await q(`SELECT version FROM nzi_console.jobs WHERE job_id = $1`, [jobId]))[0].version;
      await assert.rejects(updateJob(database.pool, { jobId, expectedVersion: version, reportingPeriodStart: "2026-01-01", reportingPeriodEnd: "2026-12-31" }, context()), refused("REQUIRED"));
      const preview = await previewJobUpdate(database.pool, { jobId, reportingPeriodStart: "2026-01-01", reportingPeriodEnd: "2026-12-31" }, context("Wrong year"));
      assert.deepEqual(preview?.refusal, []);
      assert.equal(preview?.plan.periodHasData, true);
      assert.deepEqual([preview?.outcome?.totals.before.scope1, preview?.outcome?.totals.after.scope1, preview?.outcome?.repriced.rows], [0.2, 0.1, 1]);
      assert.deepEqual([(await row()).dataset_id, (await row()).calc], ["uk-ghg-gb-2025", 0.2], "the preview is rolled back");
    });

    it("moves with the reason: datasets re-chosen for the new year, the row re-priced on its edition; a baseline-year job says so", async () => {
      const version = (await q(`SELECT version FROM nzi_console.jobs WHERE job_id = $1`, [jobId]))[0].version;
      const moved = await updateJob(database.pool, { jobId, expectedVersion: version, reportingPeriodStart: "2026-01-01", reportingPeriodEnd: "2026-12-31" }, context("Wrong year"));
      assert.deepEqual([(await row()).dataset_id, (await row()).calc], ["uk-ghg-gb-2026", 0.1]);
      assert.deepEqual([moved.data.totals.before.total, moved.data.totals.after.total, moved.data.repriced.rows], [0.2, 0.1, 1]);
      assert.equal(moved.data.baselineYearJob, true, "the job was the client's baseline year — the job offers the client the same move");
      const selections = (await q(`SELECT dataset_id FROM nzi_console.job_dataset_selections WHERE job_id = $1 AND selection_source = 'automatic'`, [jobId])).map((s) => s.dataset_id);
      assert.deepEqual(selections, ["uk-ghg-gb-2026"]);
      // B.4: the offer — client.update with only the period moved; the baseline is still pending, so no re-baseline.
      await moveClientBaselinePeriod(database.pool, { clientId: "c-move", periodStart: "2026-01-01", periodEnd: "2026-12-31" }, context());
      assert.equal((await read((db) => getBaselineYearState(db, "c-move")))?.year, 2026);
    });

    it("is refused once the job's figures are issued (a reviewed snapshot) — the supersession route, not here", async () => {
      await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by)
               VALUES ($1, 'snap-move', $2, 1, 1, $3, '{"jobNumber":"J","client":"c","reportingYear":2026,"measurements":[]}'::jsonb, 'reviewer')`, [ORG, jobId, `sha256:${"c".repeat(64)}`]);
      const version = (await q(`SELECT version FROM nzi_console.jobs WHERE job_id = $1`, [jobId]))[0].version;
      await assert.rejects(updateJob(database.pool, { jobId, expectedVersion: version, reportingPeriodStart: "2025-01-01", reportingPeriodEnd: "2025-12-31" }, context("Back")), refused("PERIOD_ISSUED"));
    });
  });
});
