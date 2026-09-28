import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { sha256Hex } from "../src/legacyReportSeal";
import { parseV7Csv, readV7Extract } from "../src/v7ClientExtract";
import {
  familyByV7NameRule, migratedRecordProblems, planV7ClientImport, type ClientImportPlan, type PlannedRow,
} from "../src/v7ClientImport";
import { JOB_100_PUBLISHED, SENTINELS, syntheticExtract, syntheticHeaders, syntheticRows, writeSyntheticExtract } from "./support/v7SyntheticExtract";

/**
 * The v7 client-and-job plan (docs/CLIENT_JOB_IMPORT_DESIGN.md), on a synthetic extract shaped like v7's. Pure: every
 * rule is checked on the plan itself, before anything is written.
 */

type Rows = ReturnType<typeof syntheticRows>;
const plan = (mutate?: (rows: Rows) => void): ClientImportPlan => {
  const rows = syntheticRows();
  mutate?.(rows);
  return planV7ClientImport({ extract: syntheticExtract(rows), headers: syntheticHeaders(), extractSha256: "synthetic" });
};
const codes = (findings: ClientImportPlan["refusals"]) => findings.map((finding) => finding.code).sort();
const jobOf = (p: ClientImportPlan, legacyId: string) => p.clients.flatMap((client) => client.jobs).find((job) => job.legacyId === legacyId)!;
const rowOf = (p: ClientImportPlan, scopeRowId: string): PlannedRow =>
  p.clients.flatMap((client) => client.jobs).flatMap((job) => job.rows).find((row) => row.scopeRowId === scopeRowId)!;

describe("the v7 client-and-job plan", () => {
  it("plans the synthetic extract with no refusal", () => {
    const p = plan();
    assert.deepEqual(p.refusals, []);
    assert.deepEqual(p.clients.map((client) => client.clientId), ["v7-client-1", "v7-client-2"]);
  });

  // ── Scope (decision 8) and the closed exclusion list ──

  it("imports Active and Portfolio Owner clients, and excludes the rest by name", () => {
    const p = plan();
    assert.equal(p.summary.portfolioOwners, 1);
    const excluded = p.excluded.map((entry) => `${entry.table} ${entry.legacyId} ${entry.reason}`).sort();
    assert.deepEqual(excluded, [
      "client_contacts 23 contact-without-name",
      "client_sites 31 record-of-excluded-parent",
      "clients 3 client-not-in-scope",
      "clients 4 client-not-in-scope",
      "job_emission_sources 5003 register-source-disabled",
      "jobs 104 job-without-client",
      "jobs 105 record-of-excluded-parent",
      "lca_assessments 8002 lca-not-frozen",
    ]);
  });

  it("refuses an orphaned record rather than dropping it", () => {
    const p = plan((rows) => { rows.job_scope_rows.push({ ...rows.job_scope_rows[0]!, row_id: "9999", job_id: "4040" }); });
    assert.deepEqual(codes(p.refusals), ["orphaned-record"]);
  });

  // ── Family (job_types.job_family, then v7's name rule; never is_crp alone) ──

  it("takes a job's family from its type, then v7's name rule — never from is_crp", () => {
    const p = plan();
    assert.deepEqual(["100", "101", "102", "103", "106", "107"].map((id) => [id, jobOf(p, id).family]), [
      ["100", "crp"], ["101", "consultancy"], ["102", "lca"], ["103", "training"], ["106", "crp"], ["107", "pcf"],
    ], "103's type is flagged is_crp and is training by name; 107's family comes from job_group");
    assert.equal(familyByV7NameRule("Monthly Support Services"), "consultancy");
    assert.equal(familyByV7NameRule("Product Carbon Footprint"), "pcf");
    assert.equal(familyByV7NameRule("Scope 3 screening"), "crp");
  });

  // ── Job numbers and statuses (decisions 1a, 5) ──

  it("keeps v7's number as the sequence, and maps status with v7's own kept as the stage", () => {
    const job = jobOf(plan(), "100");
    assert.deepEqual([job.sequence, job.legacyJobNumber, job.legacyWfmJobNo, job.status, job.workflowStage], [612, "J000612", "WFM-4411", "complete", "Completed"]);
    const archived = jobOf(plan(), "103");
    assert.deepEqual([archived.status, archived.workflowStage], ["cancelled", "Open"]);
    assert.deepEqual([job.periodStart, job.periodEnd], ["2023-01-01", "2023-12-31"], "the CRP detail's period, where the job has none");
  });

  it("refuses a non-standard or repeated job number and an unmapped status", () => {
    assert.deepEqual(codes(plan((rows) => { rows.jobs[0]!.job_number = "612"; }).refusals), ["job-number-non-standard"]);
    assert.deepEqual(codes(plan((rows) => { rows.jobs[1]!.job_number = "J000612"; }).refusals), ["job-number-repeated"]);
    assert.deepEqual(codes(plan((rows) => { rows.jobs[1]!.status = "On Ice"; }).refusals), ["job-status-unknown"]);
  });

  // ── Decision 9: v7's reported arithmetic ──

  it("migrates the figure v7 reported, keeping the stored one beside it", () => {
    const p = plan();
    const expected: Array<[string, number]> = [
      ["v7-row-1000", 1.8], ["v7-row-1001", 2.4], ["v7-row-1002", 1.5], ["v7-row-1003", 12.5], ["v7-row-1004", 12.5],
      ["v7-row-1005", 0.03], ["v7-row-1006", 0.1], ["v7-row-1007", 0.1], ["v7-source-5001", 2.5], ["v7-source-5002", 0.15],
    ];
    for (const [id, tco2e] of expected) assert.ok(Math.abs(rowOf(p, id).calculatedTco2e - tco2e) < 1e-9, `${id}: ${rowOf(p, id).calculatedTco2e} ≠ ${tco2e}`);
    const spend = rowOf(p, "v7-row-1002");
    assert.equal(spend.migratedRecord.stored_calc_tco2e, 1500, "v7's historic 1000× stored figure, kept as evidence");
    assert.ok(spend.migratedRecord.flags?.includes("stored-figure-differs"));
    const override = rowOf(p, "v7-row-1007");
    assert.equal(override.migratedRecord.override_tco2e, 99, "the override is kept — and ignored, as v7's reporting ignores it");
    assert.ok(rowOf(p, "v7-row-1003").migratedRecord.flags?.includes("v7-synthesised"));
    assert.equal(rowOf(p, "v7-row-1004").counted, false, "disabled: carried, never counted");
  });

  // ── The double-count guard (§6.1) ──

  it("makes figures only of scope rows and enabled non-commuting register sources; spend and commuting are evidence", () => {
    const p = plan();
    const ids = jobOf(p, "100").rows.map((row) => row.scopeRowId).sort();
    assert.deepEqual(ids, ["v7-row-1000", "v7-row-1001", "v7-row-1002", "v7-row-1003", "v7-row-1004", "v7-row-1005", "v7-row-1006", "v7-row-1007", "v7-source-5001", "v7-source-5002"]);
    assert.deepEqual(rowOf(p, "v7-row-1002").migratedRecord.evidence, { spend: { entry_ids: ["3001", "3002"], count: 2, amount_gross: 5000, currencies: ["GBP"] } });
    assert.deepEqual(rowOf(p, "v7-row-1005").migratedRecord.evidence, { commuting: { source_ids: ["4001", "4002"], count: 2, total_qty: 300, total_calc_tco2e: 0.03 } });
    assert.equal(rowOf(p, "v7-source-5002").migratedRecord.factor, 0.15, "a grouped source takes its group's factor, as v7's COALESCE does");
  });

  it("refuses a row stored under a consolidated-on-read source, and reports v7's own spend double count", () => {
    assert.deepEqual(codes(plan((rows) => { rows.job_scope_rows[0]!.data_source = "Asset Register (Consolidated)"; }).refusals), ["row-consolidated-on-read"]);
    const doubled = plan((rows) => { rows.job_scope_rows.push({ ...rows.job_scope_rows[2]!, row_id: "1008", data_source: "Company Data", calc_tco2e: "1.5" }); });
    assert.deepEqual(doubled.refusals, []);
    assert.ok(codes(doubled.reports).includes("spend-double-count"), "loaded as v7 left it, and shown to a person");
    const short = plan((rows) => { rows.job_spend_entries[1]!.amount_gross = "1000"; });
    assert.ok(codes(short.reports).includes("spend-row-disagrees-with-entries"));
  });

  // ── Decisions 2 and 11: the published report, and the reconciliation ──

  it("reconciles each job to the snapshot of its portal version, reporting any difference and never correcting it", () => {
    const p = plan();
    const reconciled = jobOf(p, "100").reconciliation;
    assert.deepEqual(reconciled.published, { legacyReportId: "v7-report-7001", status: "final" });
    assert.deepEqual(reconciled.migrated, JOB_100_PUBLISHED, "the port reproduces the published totals exactly");
    assert.deepEqual(reconciled.differences, []);
    const differing = jobOf(p, "106").reconciliation;
    assert.deepEqual(differing.published, { legacyReportId: "v7-report-7010", status: "review" }, "decision 11: the portal version, final or not");
    assert.deepEqual(differing.differences, ["Scope 1: published 1.5, migrated 1", "Total: published 1.5, migrated 1"]);
    assert.ok(codes(p.reports).includes("published-version-not-final"));
    assert.equal(rowOf(p, "v7-row-1100").calculatedTco2e, 1, "the difference is reported; the row keeps v7's figure");
    assert.deepEqual([p.summary.jobsPublished, p.summary.jobsReconciled, p.summary.jobsWithDifferences], [2, 1, 1]);
  });

  it("refuses a report whose snapshot does not hash to v7's data_hash, and keeps the portal flag on exactly one version", () => {
    assert.deepEqual(codes(plan((rows) => { rows.job_report_versions[1]!.data_hash = sha256Hex("something else"); }).refusals), ["report-hash-mismatch"]);
    const reports = jobOf(plan(), "100").reports;
    assert.deepEqual(reports.map((report) => [report.legacyReportId, report.isPortalVersion]), [["v7-report-7000", false], ["v7-report-7001", true]]);
    assert.equal(reports[1]!.particulars.approvedByName, "Bo Example", "the approver travels with the published version, to be sealed");
    const lca = jobOf(plan(), "102").reports;
    assert.deepEqual(lca.map((report) => [report.legacyReportId, report.kind, report.particulars.totalTco2e]), [["v7-lca-8001", "lca-result", 1.2]]);
  });

  // ── The 0133 depth test: migrated_record is PII-free at every depth ──

  it("carries no personal data or free text at any depth of any migrated_record", () => {
    const p = plan();
    const rows = p.clients.flatMap((client) => client.jobs).flatMap((job) => job.rows);
    assert.ok(rows.length >= 10);
    for (const row of rows) {
      assert.deepEqual(migratedRecordProblems(row.migratedRecord), [], `${row.scopeRowId} departs from the closed shape`);
      // The sentinels sit in every free-text and personal column v7 has: notes, override reasons, employee names,
      // source names, register detail_json, spend descriptions. None may surface in what the row stores.
      const stored = JSON.stringify([row.migratedRecord, row.provenance, row.lineage]);
      for (const sentinel of SENTINELS) assert.ok(!stored.includes(sentinel), `${row.scopeRowId} carries "${sentinel}"`);
    }
  });

  it("rejects, at any depth, a key outside the shape, an '@', and a value of the wrong kind", () => {
    const base = rowOf(plan(), "v7-row-1002").migratedRecord;
    const nestedKey = { ...base, evidence: { spend: { ...base.evidence!.spend!, description: "Taxi for a person" } } };
    assert.deepEqual(migratedRecordProblems(nestedKey), ["migrated_record.evidence.spend.description: not an allowed key"]);
    const email = { ...base, dataset: { id: "7", year: 2023, version: "a@b" } };
    assert.ok(migratedRecordProblems(email).some((problem) => problem.includes('carries an "@"')));
    const freeText = { ...base, register: { source_id: "1", group_id: null, source_type: "Van driven by someone", source_subtype: null } };
    assert.ok(migratedRecordProblems(freeText).some((problem) => problem.startsWith("migrated_record.register.source_type")));
    const unlisted = { ...base, data_source: "Entered by someone" };
    assert.ok(migratedRecordProblems(unlisted).some((problem) => problem.startsWith("migrated_record.data_source")));
    // And the plan refuses one, rather than storing it.
    const refused = plan((rows) => { rows.job_scope_rows[0]!.uom = "kWh (per Ada, ada@example.invalid)"; });
    assert.ok(codes(refused.refusals).includes("migrated-record-not-closed"));
  });

  it("carries an unlisted data_source as 'Other', reported, never as its text", () => {
    const p = plan((rows) => { rows.job_scope_rows[0]!.data_source = "Typed in by ZZSENTINEL Person"; });
    assert.deepEqual(p.refusals, []);
    assert.equal(rowOf(p, "v7-row-1000").migratedRecord.data_source, "Other");
    assert.ok(codes(p.reports).includes("data-source-unlisted"));
  });

  // ── Master records ──

  it("settles v7's duplicates the console forbids, and reports each", () => {
    const p = plan();
    const alpha = p.clients[0]!;
    assert.deepEqual(alpha.sites.map((site) => [site.siteId, site.name, site.isRegisteredOffice]), [
      ["v7-site-11", "Head Office", true], ["v7-site-12", "Depot", false], ["v7-site-13", "head office (v7 site 13)", false],
    ]);
    assert.deepEqual(alpha.contacts.map((contact) => [contact.contactId, contact.isPrimary]), [["v7-contact-21", true], ["v7-contact-22", false]]);
    for (const code of ["site-name-repeated", "registered-office-closed", "contact-primary-repeated"]) assert.ok(codes(p.reports).includes(code), code);
    assert.equal(alpha.fields.financialYearEndMonth, 3);
    assert.deepEqual(alpha.target?.scope1, { year: 2030, pct: 50 });
    assert.ok(codes(p.reports).includes("client-targets-at-v7-defaults"), "client 2 holds v7's column defaults");
  });

  // ── The extract on disk ──

  it("reads the extract back byte for byte — NULL apart from '', quotes, commas, newlines and non-ASCII intact", () => {
    const directory = mkdtempSync(join(tmpdir(), "v7-extract-"));
    try {
      const manifestSha = writeSyntheticExtract(directory);
      const read = readV7Extract(directory);
      assert.deepEqual(read.problems, []);
      assert.equal(read.extractSha256, manifestSha);
      const fromDisk = planV7ClientImport({ extract: read.extract, headers: read.headers, extractSha256: read.extractSha256 });
      assert.deepEqual(fromDisk.refusals, [], "every snapshot still hashes to v7's data_hash after the CSV round trip");
      assert.deepEqual(parseV7Csv('a,b,c\n"",,"x"\n').rows, [{ a: "", b: null, c: "x" }]);

      writeFileSync(join(directory, "jobs.csv"), readFileSync(join(directory, "jobs.csv"), "utf8").replace("CRP 2023", "CRP 2O23"));
      assert.deepEqual(readV7Extract(directory).problems, ["jobs: jobs.csv does not hash to the manifest's sha256"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses an extract missing a column the import reads", () => {
    const headers = syntheticHeaders();
    headers.job_scope_rows = headers.job_scope_rows.filter((column) => column !== "ghg_unit");
    const p = planV7ClientImport({ extract: syntheticExtract(), headers, extractSha256: "synthetic" });
    assert.deepEqual(p.refusals.map((finding) => finding.examples), [["job_scope_rows.ghg_unit"]]);
  });
});
