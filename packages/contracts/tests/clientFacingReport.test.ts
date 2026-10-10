import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clientFacingComposition, clientFacingPublishedReport, CLIENT_WITHHELD_IDENTITY_FIELDS, reportMethodologyRows, type PublishedCrpReportReadModel, type ReportComposition } from "../src/index";

/**
 * F-4b (ruled on F-4a's staff-identity finding): the client's copy of a published report and of its issued document names
 * none of the issuer's staff — and changes no figure.
 */
const STAFF = "staff-zq";
const report = (): PublishedCrpReportReadModel => ({
  reportVersionId: "rv", manifestVersion: 1, publishedAt: "2026-02-01T00:00:00.000Z", dataHash: "sha256:a",
  snapshot: {
    id: "s", jobId: "j", jobNumber: "J1", client: "Co", reportingYear: 2025, version: 1, jobVersion: 1, createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: `${STAFF}-preparer`, approvedBy: `${STAFF}-approver`, approvedAt: "2026-01-02T00:00:00.000Z", dataHash: "sha256:a",
    target: { jobId: "j", baselineYear: 2024, baselineTco2e: 40, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045, version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: `${STAFF}-target` },
    intensityTarget: { jobId: "j", metric: "turnover", denominatorUnit: "£m", reportingDenominator: 12.5, baselineYear: 2024, baselineIntensity: 3, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045, version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: `${STAFF}-intensity` },
    annualComparison: [],
    sections: [{ key: "executive-summary", title: "Executive summary", ordinal: 10, contentSource: "template", bodyHtml: "<p>x</p>", version: 1, updatedBy: `${STAFF}-section`, updatedAt: "2026-01-01T00:00:00.000Z" }],
    gapResolutions: [{ gapKey: "g", reason: "nil", resolvedBy: `${STAFF}-gap`, resolvedAt: "2026-01-01T00:00:00.000Z" }],
    measurements: [{ rowId: "r", rowVersion: 1, scope: "1", sourceLabel: "Gas", tco2e: 10, factorSet: "demo", qualityTier: "measured", reviewedBy: `${STAFF}-row` }],
  } as unknown as PublishedCrpReportReadModel["snapshot"],
});

describe("the client's copy names none of the issuer's staff (F-4b)", () => {
  it("strips every staff identity the published report carries — and only those", () => {
    const full = report();
    assert.equal(JSON.stringify(full).split(STAFF).length - 1, 7, "the fixture seeds all seven");
    assert.equal(CLIENT_WITHHELD_IDENTITY_FIELDS.length, 7);
    const client = clientFacingPublishedReport(full);
    assert.ok(!JSON.stringify(client).includes(STAFF));
    assert.deepEqual(client.snapshot.measurements, [{ rowId: "r", rowVersion: 1, scope: "1", sourceLabel: "Gas", tco2e: 10, factorSet: "demo", qualityTier: "measured" }]);
    assert.deepEqual([client.snapshot.target?.baselineTco2e, client.snapshot.intensityTarget?.reportingDenominator, client.snapshot.approvedAt, client.dataHash], [40, 12.5, "2026-01-02T00:00:00.000Z", "sha256:a"]);
    assert.ok(JSON.stringify(full).includes(STAFF), "the input is untouched");
  });

  it("the issued document: no reviewer (so no 'Reviewed by' line), no strategy owner, no chart-basis editor", () => {
    const composition = {
      assurance: { kind: "internal-review", statement: "Reviewed snapshot (internal review); not third-party assured.", reviewedBy: `${STAFF}-reviewer`, reviewedAt: "2026-01-01T00:00:00.000Z" },
      plan: { groups: [{ strategies: [{ owner: `${STAFF}-owner`, title: "LED" }] }] },
      chartBasis: { intensityTarget: { metric: "turnover", updatedBy: `${STAFF}-intensity` }, measurements: [] },
      emissions: { state: "unavailable", reason: "x" }, intensity: { state: "unavailable", reason: "x" }, targets: { state: "unavailable", reason: "x" },
      issuedAt: "2026-02-01T00:00:00.000Z", snapshotDataHash: "sha256:a",
    } as unknown as ReportComposition;
    const client = clientFacingComposition(composition);
    assert.ok(!JSON.stringify(client).includes(STAFF));
    assert.ok(reportMethodologyRows(composition).some((row) => row.label === "Reviewed by"), "the staff copy has the line");
    assert.ok(!reportMethodologyRows(client).some((row) => row.label === "Reviewed by"), "the client's has none — no name, no organisation in its place");
    assert.ok(reportMethodologyRows(client).some((row) => row.label === "Assurance basis" && /internal review/.test(row.value)), "the basis stands alone");
    assert.equal((client.chartBasis!.intensityTarget as { metric?: string }).metric, "turnover", "the chart keeps its figures");
    assert.ok(JSON.stringify(composition).includes(STAFF), "the input is untouched");
  });
});
