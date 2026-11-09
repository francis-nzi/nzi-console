import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { COMMUTING_UPLIFT_METHOD_LINE, commandGrantForRole, defaultReportSectionPlan, setReportSectionIncluded, type CommandContext, type ReportComposition, type ReportScope, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { publishCrpReport, validateCrpReport } from "../src/postgresCommands";
import { getReportComposition, previewReportComposition } from "../src/reportCompositions";
import { withTenantRead } from "../src/postgres";

/**
 * composed@7 (BRIEF-commuting-uplift-methodology-line), against a real database: the snapshot's `commutingUplift` — its methodology
 * line and per-site provenance — is carried into the composition the version freezes, cut to the sites the report covers, and the
 * report is stamped composed@7 exactly then. A snapshot without the block composes as it always did (no key, the earlier
 * renderer); an issued report keeps what it froze however the live headcount moves afterwards.
 */
const ORG = "c7-org";
const CLIENT = "c7-client";

describe("composed@7 carries the snapshot's extrapolated-commuting statement, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let count = 0;
  const context = (actor: string, role: StaffRole): CommandContext => {
    count += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `c7-${count}`, correlationId: `corr-c7-${count}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const provenance = (siteId: string, siteLabel: string, respondents: number, eligible: number) => ({
    siteId, siteLabel, employees: eligible + 10, companyCarUsers: 10, respondents, eligible, responseRate: respondents / eligible,
    headcount: eligible - respondents, factor: eligible / respondents, agreedBy: "ada", agreedAt: "2026-11-01T09:00:00.000Z",
  });
  const UPLIFT = { method: COMMUTING_UPLIFT_METHOD_LINE, sites: [provenance("s-a", "Works", 54, 90)] };
  // A snapshot's rows, one per site: Scope 1 and the 3.7 commuting figure.
  const snapshot = async (id: string, jobId: string, uplift: unknown) => {
    const rows: Array<[string, string, number]> = [["s-a", "1", 30], ["s-a", "3.7", 20], ["s-b", "1", 15], ["s-b", "3.7", 6]];
    const measurements = rows.map(([site, code, tco2e], index) => ({ rowId: `${id}-${index}`, rowVersion: 1, scope: code.split(".")[0], scopeCode: code, siteId: site,
      siteLabel: site === "s-a" ? "Works" : "Depot", sourceLabel: `Category ${code}`, tco2e, factorSet: `Category ${code} · dataset`, qualityTier: "measured", factorSource: "dataset" }));
    const payload = { jobNumber: `J-${jobId}`, client: "Composed Seven Co", reportingYear: 2025, measurements, annualComparison: [],
      provenance: { resolver: "crp.snapshot.issue@2", reportingPeriod: { from: "2025-04-01", to: "2026-03-31" },
        boundary: { siteIds: ["s-a", "s-b"], excludedRowIds: [] }, factorSets: [{ source: "dataset", id: "uk-ghg-gb-2025", name: "upload.xlsx", version: "upload.xlsx" }] },
      ...(uplift ? { commutingUplift: uplift } : {}) };
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by, approved_by, approved_at)
             VALUES ($1, $2, $3, 1, 1, $4, $5::jsonb, 'prep', 'rev', now())`, [ORG, id, jobId, `sha256:${sha(id)}`, JSON.stringify(payload)]);
  };
  const job = async (jobId: string, sequence: number) => {
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, $4, 'crp', 'CRP', 'open', 'delivery', 2025)`, [ORG, jobId, CLIENT, sequence]);
    await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2025-04-01', '2026-03-31', 'GB')`, [ORG, jobId]);
  };
  // No targets or intensity measures here, so the plan leaves those two sections out (validate's R4 would refuse their charts).
  const plan = setReportSectionIncluded(setReportSectionIncluded(defaultReportSectionPlan, "targets", false), "intensity", false);
  // One validated version per snapshot and scope (a second validate at the same scope is refused): memoised, so a test reuses it.
  const versions = new Map<string, Promise<string>>();
  const validate = (snapshotId: string, scope?: ReportScope) => {
    const key = `${snapshotId}:${JSON.stringify(scope ?? null)}`;
    if (!versions.has(key)) versions.set(key, validateCrpReport(database.pool, { reviewedSnapshotId: snapshotId, manifestVersion: 1, sectionPlan: plan, ...(scope ? { scope } : {}) }, context("rev", "reviewer")).then((result) => result.data.reportVersionId));
    return versions.get(key)!;
  };
  const preview = async (id: string) => (await withTenantRead(database.pool, ORG, (db) => previewReportComposition(db, { organisationId: ORG, reportVersionId: id })))!.composition;
  const frozen = async (id: string) => (await withTenantRead(database.pool, ORG, (db) => getReportComposition(db, id)))!;

  before(async () => {
    database = (await createDisposableDatabase("reportcomposed7"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada'), ($1, 'rev', 'reviewer', 'active', 'Rev')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, 'Composed Seven Co', 'active', 'GBP')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.client_sites (organisation_id, site_id, client_id, name, in_service_from, created_by) VALUES ($1, 's-a', $2, 'Works', '2019-04-01', 'seed'), ($1, 's-b', $2, 'Depot', '2021-09-01', 'seed')`, [ORG, CLIENT]);
    await job("j-up", 9771); await snapshot("snap-up", "j-up", UPLIFT);
    await job("j-plain", 9772); await snapshot("snap-plain", "j-plain", null);
  });
  after(async () => { await database?.end(); });

  it("a snapshot with the block is composed@7, carrying its method line and per-site provenance exactly as the snapshot froze them", async () => {
    const drawn = await preview(await validate("snap-up"));
    assert.equal(drawn.renderer, "composed@7");
    assert.deepEqual(drawn.commutingUplift, UPLIFT);
    assert.equal(drawn.commutingUplift!.method, COMMUTING_UPLIFT_METHOD_LINE);
    assert.ok(Array.isArray(drawn.narrative), "composed@7 still draws the frozen narrative");
  });

  it("a snapshot WITHOUT the block composes as it always did: composed@6, and no uplift key at all", async () => {
    const drawn = await preview(await validate("snap-plain"));
    assert.equal(drawn.renderer, "composed@6");
    assert.equal("commutingUplift" in drawn, false);
  });

  it("a site-scoped report states only the uplifted sites it covers: the uplifted site's report does, the other site's does not", async () => {
    const works = await preview(await validate("snap-up", { kind: "sites", siteIds: ["s-a"] }));
    assert.equal(works.renderer, "composed@7");
    assert.deepEqual(works.commutingUplift!.sites.map((site) => site.siteId), ["s-a"]);
    const depot = await preview(await validate("snap-up", { kind: "sites", siteIds: ["s-b"] }));
    assert.equal(depot.renderer, "composed@6", "no uplifted site in this report: no statement, the earlier renderer");
    assert.equal("commutingUplift" in depot, false);
  });

  it("is deterministic and frozen: recomposing the same snapshot gives the same composition, and what publish freezes survives a later headcount change", async () => {
    const id = await validate("snap-up");
    const [first, second] = [await preview(id), await preview(id)];
    const without = (composition: ReportComposition) => JSON.parse(JSON.stringify(composition).split(composition.issuedAt).join("<issued>"));
    assert.deepEqual(without(first), without(second));
    await publishCrpReport(database.pool, { reportVersionId: id, expectedStatus: "validated", expectedVersion: 1, manifestVersion: 1, reviewedSnapshotId: "snap-up" }, context("rev", "reviewer"));
    // A live headcount appearing (or changing) afterwards is a different read the issued report never makes.
    await q(`INSERT INTO nzi_console.job_site_headcount (organisation_id, job_id, site_id, employees, company_car_users, uplift_enabled, updated_by) VALUES ($1, 'j-up', 's-a', 500, 0, true, 'ada')`, [ORG]);
    const issued = await frozen(id);
    assert.equal(issued.renderer, "composed@7");
    assert.deepEqual(without(issued), without(first));
    assert.deepEqual(issued.commutingUplift, UPLIFT);
  });

  it("the block is the snapshot's own, never a live read: a snapshot whose payload holds none stays without one even when a headcount record is switched on", async () => {
    await q(`INSERT INTO nzi_console.job_site_headcount (organisation_id, job_id, site_id, employees, company_car_users, uplift_enabled, updated_by) VALUES ($1, 'j-plain', 's-a', 500, 0, true, 'ada')`, [ORG]);
    const drawn = await preview(await validate("snap-plain"));
    assert.equal(drawn.renderer, "composed@6");
    assert.equal("commutingUplift" in drawn, false);
  });
});
