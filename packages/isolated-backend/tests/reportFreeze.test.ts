import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { freezeReportComposition, getReportComposition } from "../src/reportCompositions";
import { composeReportPlan, reportAssurance, strategyControlLevelLabels, strategyControlLevels, type ClientStrategy, type ReportComposition } from "@nzi/contracts";

/**
 * The keystone property of an issued report: **it does not move**.
 *
 * A report quotes four things that go on changing after the client has the document — the
 * intensity measures, the targets, the decarbonisation plan and the SRS readiness. Pinning
 * only the reviewed snapshot would look like immutability while leaving all four free to
 * drift, so publishing freezes a composition. This asserts that freeze actually holds:
 * issue, then mutate the sources underneath it, then read the issued report back and expect
 * it byte-for-byte unchanged.
 *
 * Against a real Postgres, because the property is about what the database returns, not
 * about what a mock was told to say.
 */

const EVIDENCE_HASH = `sha256:${"a".repeat(64)}`;

const DATABASE_URL = TEST_DATABASE_URL;

const strategy = (id: string, over: Partial<ClientStrategy> = {}): ClientStrategy => ({
  id, clientId: "client-a", strategyId: null, leverIds: ["lever-energy"],
  srsRequirementIds: ["req-1"], includeInReport: true, title: id, scope: "2", category: "Energy",
  controlLevel: "direct_control", iconKey: "energy", status: "planned", owner: "", targetDate: null,
  progressPct: 0, notes: "", active: true, version: 1, estimate: null, ...over,
});

const LEVERS = [{ id: "lever-energy", key: "energy", title: "Energy", iconKey: "energy", ordering: 1, active: true }];
const CODES = new Map([["req-1", "S2 M2"]]);

describe("an issued report does not move", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let client: pg.Client;
  let database: DisposableDatabase;

  before(async () => {
    // This suite owns its own database, so a parallel suite cannot drop the schema underneath it.
    database = (await createDisposableDatabase("reportfreeze"))!;
    client = await database.admin();
    // Enough of a world to hang a report version off. The composition itself is built here
    // rather than through publish: publish's own wiring is asserted separately, and what
    // this test is about is whether a frozen composition survives its sources changing.
    await client.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ('org-a', 'Org A')`);
    await client.query(
      `INSERT INTO nzi_console.clients (organisation_id, client_id, name, status)
       VALUES ('org-a', 'client-a', 'Client A', 'active')`);
    // `job_number` is generated from `sequence`, so it is not supplied.
    await client.query(
      `INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage)
       VALUES ('org-a', 'job-a', 'client-a', 1, 'crp', 'CRP', 'open', 'delivery')`);
    // A report version references a real reviewed snapshot, and `data_hash` is CHECK-
    // constrained to an actual sha256 — so the fixture uses one rather than a placeholder.
    await client.query(
      `INSERT INTO nzi_console.reviewed_crp_snapshots
         (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by)
       VALUES ('org-a', 'snapshot-a', 'job-a', 1, 1, $1, $2::jsonb, 'preparer-a')`,
      [EVIDENCE_HASH, JSON.stringify({ jobNumber: "J000001", client: "Client A", reportingYear: 2025, measurements: [], annualComparison: [] })]);
    await client.query(
      `INSERT INTO nzi_console.report_versions (organisation_id, report_version_id, job_id, status, manifest_version, reviewed_snapshot_id, data_hash)
       VALUES ('org-a', 'version-1', 'job-a', 'published', 1, 'snapshot-a', $1)`,
      [EVIDENCE_HASH]);
  });

  after(async () => { await client?.end(); await database?.end(); });

  it("returns what was frozen after the plan underneath it changes", async () => {
    const plan = composeReportPlan([strategy("s1", { status: "in_progress", progressPct: 60 }), strategy("s2")], LEVERS, CODES);

    const composition = {
      reportVersionId: "version-1", jobId: "job-a", jobNumber: "J000001", client: "Client A",
      reportingYear: 2025, issuedAt: "2026-04-01T00:00:00.000Z",
      snapshotId: "snapshot-a", snapshotDataHash: EVIDENCE_HASH,
      assurance: reportAssurance({ reviewedBy: "reviewer-a", reviewedAt: "2026-03-30T00:00:00.000Z" }),
      emissions: { state: "unavailable", reason: "not part of this test" },
      intensity: { state: "unavailable", reason: "not part of this test" },
      targets: { state: "unavailable", reason: "not part of this test" },
      plan,
      srs: { state: "unavailable", reason: "not part of this test" },
    } as unknown as ReportComposition;

    const frozen = await freezeReportComposition(client as never, {
      organisationId: "org-a", composition, issuedBy: "publisher-a",
    });
    assert.equal(frozen.reused, false, "the first freeze writes a row");

    const issued = JSON.stringify(await getReportComposition(client as never, "version-1"));

    // Now change every source the report quotes, the way a consultant would next week.
    // A strategy and its SRS alignment are one fact, so they go in one transaction: the
    // "at least one requirement" trigger is deferred and judges the transaction at commit.
    // Inserting the strategy alone — as this fixture once did — is exactly what the trigger
    // exists to refuse.
    await client.query(`BEGIN`);
    await client.query(
      `INSERT INTO nzi_console.client_strategies (organisation_id, client_strategy_id, client_id, bespoke_title, bespoke_scope, bespoke_control_level, created_by)
       VALUES ('org-a', 'added-later', 'client-a', 'Added after the report was issued', '1', 'direct_control', 'tester')`);
    await client.query(
      `INSERT INTO nzi_console.client_strategy_srs_requirements (organisation_id, client_strategy_id, framework_id, requirement_id)
       SELECT organisation_id, 'added-later', framework_id, requirement_id
       FROM nzi_console.srs_requirements WHERE organisation_id = 'org-a' ORDER BY requirement_id LIMIT 1`);
    await client.query(`COMMIT`);
    await client.query(
      `UPDATE nzi_console.reduction_strategies SET title = 'Renamed after the report was issued'
       WHERE organisation_id = 'org-a' AND strategy_key = 'solar-pv'`);
    await client.query(`DELETE FROM nzi_console.strategy_levers WHERE organisation_id = 'org-a'`);

    const afterwards = JSON.stringify(await getReportComposition(client as never, "version-1"));
    assert.equal(afterwards, issued, "the issued report is byte-identical after its sources changed");
  });

  it("refuses to be edited, so a correction has to be a new version", async () => {
    // The guarantee is the grant, not that nobody tries. This connects as the owner — which
    // bypasses grants — so asserting the grant is the honest check; attempting an UPDATE
    // here would succeed and prove nothing about what the application can do.
    const { rows } = await client.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'nzi_console' AND table_name = 'report_compositions' AND grantee = 'nzi_console_app'`);
    const granted = new Set(rows.map((row) => row.privilege_type));
    assert.ok(granted.has("SELECT") && granted.has("INSERT"), "the application can issue and read reports");
    assert.ok(!granted.has("UPDATE"), "and cannot edit one after it is issued");
    assert.ok(!granted.has("DELETE"), "or remove it");
  });

  it("reuses the row when the same facts are issued again", async () => {
    const existing = await getReportComposition(client as never, "version-1");
    const again = await freezeReportComposition(client as never, {
      organisationId: "org-a", composition: existing!, issuedBy: "publisher-a",
    });
    assert.equal(again.reused, true, "identical facts are the same composition, not a second truth");

    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text FROM nzi_console.report_compositions WHERE report_version_id = 'version-1'`);
    assert.equal(rows[0]!.count, "1", "one composition per issued version");
  });
});
