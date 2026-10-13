import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auditFactorAndSource, composeReportAudit, composeReportSources, type AuditMeasurement, type SnapshotProvenanceStamp } from "../src/index";

// B1 (composed@3): a report's sources and audit appendix, composed from the reviewed snapshot and frozen. Synthetic stamp,
// shaped like a re-ingested job's: dataset name and version are upload file names, and two datasets share one.
const stamp: SnapshotProvenanceStamp = {
  resolver: "crp.snapshot.issue@2", reportingPeriod: { from: "2025-01-01", to: "2025-12-31" },
  factorSets: [
    { source: "dataset", id: "uk-ghg-gb-2026", name: "tmpupload1.csv", version: "tmpupload1.csv" },
    { source: "dataset", id: "uk-ghg-gb-2025", name: "shared-2019-2025.xlsx", version: "shared-2019-2025.xlsx" },
    { source: "dataset", id: "nzi-gb-2025", name: "shared-2019-2025.xlsx", version: "shared-2019-2025.xlsx" },
    { source: "client", id: "cf-1", name: "Client factor · Recycled steel", version: "v3" },
  ],
  boundary: { siteIds: [], excludedRowIds: [] },
};
const row = (overrides: Partial<AuditMeasurement>): AuditMeasurement => ({ scope: "1", scopeCode: "1", tco2e: 1, sourceLabel: "Gas", siteId: null, siteLabel: null, factorSet: "Natural gas · tmpupload1.csv", factorSource: "dataset", qualityTier: "measured", ...overrides });

describe("a composed@3 report's sources", () => {
  it("names the snapshot and each stamped set by id, once — the summary every chart and section shows", () => {
    assert.deepEqual(composeReportSources({ jobNumber: "J000001", provenance: stamp }), {
      summary: "Reviewed snapshot J000001 · Client factor · Recycled steel · DESNZ GB 2025 · DESNZ GB 2026 · NZI GB 2025",
      sets: [
        { source: "dataset", id: "uk-ghg-gb-2026", label: "DESNZ GB 2026" }, { source: "dataset", id: "uk-ghg-gb-2025", label: "DESNZ GB 2025" },
        { source: "dataset", id: "nzi-gb-2025", label: "NZI GB 2025" }, { source: "client", id: "cf-1", label: "Client factor · Recycled steel" },
      ],
    });
  });

  it("is absent without a stamp — the report then names what it always did", () => {
    assert.equal(composeReportSources({ jobNumber: "J000001" }), undefined);
    assert.equal(composeReportSources({ jobNumber: "J000001", provenance: { ...stamp, factorSets: [] } }), undefined);
  });
});

describe("an audit row's factor and source", () => {
  it("one stamped dataset matching the row's version names it; the version (a file name) is never shown", () => {
    assert.deepEqual(auditFactorAndSource(row({}), stamp), { factor: "Natural gas", source: "DESNZ GB 2026" });
  });

  it("two datasets sharing a stored version are both named — the snapshot cannot say which", () => {
    assert.deepEqual(auditFactorAndSource(row({ factorSet: "Diesel · shared-2019-2025.xlsx" }), stamp), { factor: "Diesel", source: "DESNZ GB 2025 / NZI GB 2025" });
  });

  it("no match says 'Not recorded' — a file-name version is dropped, an ordinary version kept with its factor", () => {
    assert.deepEqual(auditFactorAndSource(row({ factorSet: "Diesel · other-upload.csv" }), stamp), { factor: "Diesel", source: "Not recorded" });
    assert.deepEqual(auditFactorAndSource(row({ factorSet: "DEFRA 2024 · v1.2" }), stamp), { factor: "DEFRA 2024 · v1.2", source: "Not recorded" });
    assert.deepEqual(auditFactorAndSource(row({ factorSet: "lonely.xlsx" }), stamp), { factor: "Not recorded", source: "Not recorded" });
    assert.deepEqual(auditFactorAndSource(row({ factorSet: "" }), stamp), { factor: "Not recorded", source: "Not recorded" });
    assert.deepEqual(auditFactorAndSource(row({}), undefined), { factor: "Natural gas", source: "Not recorded" }, "no stamp");
  });

  it("a client factor is named as one", () => {
    assert.deepEqual(auditFactorAndSource(row({ factorSource: "client", factorSet: "Recycled steel · v3" }), stamp), { factor: "Recycled steel · v3", source: "Client factor" });
  });
});

describe("the audit appendix", () => {
  const measurements = [
    row({ scope: "3", scopeCode: "3.10", tco2e: 2, sourceLabel: "Processing", siteId: "s-b", siteLabel: "Annex" }),
    row({ scope: "3", scopeCode: "3.6", tco2e: 7, sourceLabel: "Flights", siteId: null, reportLabel: "Business travel — air" }),
    row({ scope: "1", scopeCode: "1", tco2e: 3, sourceLabel: "Gas", siteId: "s-a", siteLabel: "Works" }),
    row({ scope: "1", scopeCode: "1", tco2e: 5, sourceLabel: "Diesel", siteId: "s-b", siteLabel: "Annex", qualityTier: null, factorSet: "Diesel · shared-2019-2025.xlsx" }),
  ];

  it("lists every row by scope code (3.6 before 3.10), largest first, with its category, activity, site, factor, source and tier", () => {
    const audit = composeReportAudit({ measurements, provenance: stamp, scope: { kind: "whole" } });
    assert.deepEqual(audit.rows.map((entry) => [entry.scopeCode, entry.activity, entry.site, entry.source, entry.tco2e]), [
      ["1", "Diesel", "Annex", "DESNZ GB 2025 / NZI GB 2025", 5], ["1", "Gas", "Works", "DESNZ GB 2026", 3],
      ["3.6", "Business travel — air", null, "DESNZ GB 2026", 7], ["3.10", "Processing", "Annex", "DESNZ GB 2026", 2],
    ]);
    assert.equal(audit.totalTco2e, 17);
    assert.equal(audit.rows[0]!.qualityTier, null, "a row with no tier says so; nothing is guessed");
    assert.ok(audit.rows.every((entry) => entry.category.length > 0));
  });

  it("a site view keeps only its sites' rows — the filter its chart basis uses — so the total is the view's", () => {
    const audit = composeReportAudit({ measurements, provenance: stamp, scope: { kind: "sites", siteIds: ["s-b"] } });
    assert.deepEqual(audit.rows.map((entry) => entry.activity), ["Diesel", "Processing"]);
    assert.equal(audit.totalTco2e, 7);
  });

  it("carries no quantity — a spend-based row's quantity is money (NZC-120) — and no file name", () => {
    const audit = composeReportAudit({ measurements: [...measurements, { ...row({ scopeCode: "3.1", scope: "3" }), sourceQuantity: 4100000 } as AuditMeasurement], provenance: stamp, scope: { kind: "whole" } });
    assert.deepEqual(Object.keys(audit.rows[0]!).sort(), ["activity", "category", "factor", "qualityTier", "scope", "scopeCode", "site", "source", "tco2e"]);
    assert.doesNotMatch(JSON.stringify(audit), /\.csv|\.xlsx|4100000/);
  });
});
