import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { clean, normaliseCode, parseCsv, planV7Load, type ExtractRow } from "../src/v7ReferenceImport";
import { countryCodeFor } from "../src/v7Countries";

/**
 * The v7 transform, rule by rule (REFERENCE_DATA_DESIGN §3–5), on a synthetic extract shaped exactly like v7's
 * factor_lookup — same columns, same "NaN"/"null" habits, same code shapes — with invented values. The real sample is
 * production-derived and is never committed (NZC-020); it is run locally before a load.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = parseCsv(readFileSync(resolve(here, "fixtures/v7-factor-lookup-synthetic.csv"), "utf8"));
const REGISTRY = [["-c", "3.7"], ["-b", "3.6"], ["-p", "3.1"], ["-u", "3.4"], ["-d", "3.9"], ["-w", "3.5"],
  ["-vcd", "1"], ["-vcp", "1"], ["-vh", "1"], ["-vvd", "1"], ["-bcp", "3.6"]]
  .map(([suffixCode, ghgCategory]) => ({ suffixCode, ghgCategory, label: suffixCode, status: "active" }) as never);
const plan = (rows: readonly ExtractRow[] = FIXTURE, precedence = {}) => planV7Load(rows, REGISTRY, { precedence });
const codes = (findings: { code: string }[]) => findings.map((finding) => finding.code).sort();
const row = (over: Partial<ExtractRow>): ExtractRow => ({ ...FIXTURE[0]!, ...over }) as ExtractRow;

describe("cleaning and ids", () => {
  it("reads empty, 'NaN' and 'null' as absent, and nothing else", () => {
    for (const absent of ["", "  ", "NaN", "null"]) assert.equal(clean(absent), null);
    for (const kept of ["0", "nan", "Null value", "N/A"]) assert.equal(clean(kept), kept.trim());
  });

  it("keeps a code with digits exactly — suffix and case included — and slugs a name", () => {
    assert.equal(normaliseCode(" 21_316_3178_11_1 "), "21_316_3178_11_1");
    assert.equal(normaliseCode("SPEND-SIC-49.3-5-u"), "SPEND-SIC-49.3-5-u");
    assert.equal(normaliseCode("1"), "1");
    assert.equal(normaliseCode("Puerto  Rico"), "puerto-rico");
    assert.equal(normaliseCode("Côte d'Ivoire"), "cote-d-ivoire");
  });

  it("matches v7's country names to ISO codes, and refuses one it cannot match", () => {
    assert.equal(countryCodeFor("United Kingdom"), "GB");
    assert.equal(countryCodeFor("Tanzania_United Republic of"), "TZ");
    assert.equal(countryCodeFor("Saint Kitts and Nevis"), "KN");
    assert.equal(countryCodeFor("Rest of World"), "ROW");
    assert.equal(countryCodeFor("Narnia"), null);
  });
});

describe("the plan for the synthetic extract", () => {
  const result = plan();

  it("is safe to load: no refusal", () => {
    assert.deepEqual(result.refusals, []);
  });

  it("collapses an identical repeat, skips a row not in kgCO2e, and loads the rest", () => {
    assert.equal(result.summary.extracted, 18);
    assert.equal(result.summary.duplicatesCollapsed, 1);
    assert.equal(result.summary.skippedNotKgco2e, 1);
    assert.equal(result.factors.length, 16);
  });

  it("mints <family>-<normalised code>, stores the code verbatim, and points each row at its lookup row", () => {
    const ids = result.factors.map((factor) => factor.factorId);
    for (const expected of ["uk-ghg-10_100_1000_1_1", "uk-ghg-10_100_1000_1_1-vcp", "iea-norway", "iea-puerto-rico", "ice-1", "ceda-561600", "nzi-99_100_1004_6_1", "uk-ghg-SPEND-SIC-49.3-5-d"]) {
      assert.ok(ids.includes(expected), `missing ${expected}`);
    }
    const puerto = result.factors.find((factor) => factor.factorId === "iea-puerto-rico")!;
    assert.equal(puerto.legacyOriginalId, "Puerto Rico");
    assert.equal(puerto.legacyDbId, "10");
  });

  it("builds one dataset per family, country and year, with ISO countries and the ruled licence", () => {
    assert.deepEqual(result.datasets.map((dataset) => `${dataset.datasetId}:${dataset.countryCode}`).sort(), [
      "ceda-ag-2025:AG", "ceda-row-2025:ROW", "ice-gb-2026:GB", "iea-no-2025:NO", "iea-pr-2025:PR",
      "nzi-gb-2023:GB", "uk-ghg-gb-2024:GB", "uk-ghg-gb-2025:GB",
    ]);
    const ice = result.datasets.find((dataset) => dataset.datasetId === "ice-gb-2026")!;
    assert.equal(ice.licence, "Source: RICS / BRE ICE Database V4.1 (Oct 2025). Free public information, reproduced with attribution for open stakeholder verification.");
    assert.deepEqual([ice.validFrom, ice.validTo], ["2026-01-01", "2026-12-31"], "a dataset with no dates was not bounded by its year");
    assert.match(ice.contentSha256, /^[0-9a-f]{64}$/);
  });

  it("keeps one identity per code within its family, across years and countries — currencies included", () => {
    assert.equal(result.identities.filter((identity) => identity.factorId === "uk-ghg-10_100_1000_1_1").length, 1);
    const ceda = result.identities.filter((identity) => identity.factorId === "ceda-561600");
    assert.equal(ceda.length, 1, "CEDA's code in two countries, priced in two currencies, was not one identity");
    const car = result.identities.find((identity) => identity.factorId === "uk-ghg-10_100_1000_1_1")!;
    assert.equal(car.legacyDbId, "1", "the identity does not point at the lowest lookup row carrying the code");
    assert.equal(car.sourceFamily, "uk-ghg");
  });

  it("writes 'NaN' and 'null' levels as absent, and keeps the calorific basis in the label", () => {
    const commuting = result.factors.find((factor) => factor.factorId === "uk-ghg-10_100_1000_1_1-c")!;
    assert.deepEqual(commuting.sourceLevels, ["Passenger vehicles", "Cars", "Average car"]);
    const net = result.factors.find((factor) => factor.factorId === "uk-ghg-20_200_2000_7_1")!;
    assert.equal(net.activityUnit, "kWh");
    assert.match(net.label, /kWh \(Net CV\)$/);
  });

  it("keeps factor_lookup's category — the suffix-aware one — on a suffixed row", () => {
    assert.equal(result.factors.find((factor) => factor.factorId === "uk-ghg-SPEND-SIC-49.3-5-d")!.sourceCategory,
      "Downstream Transportation and Distribution");
  });

  it("reports, without refusing: -w, unmapped units, currencies, defaulted countries and a variant with no base", () => {
    const reported = codes(result.reports);
    for (const expected of ["w-suffix", "unmapped-unit", "currency-unit", "country-defaulted", "variant-without-base", "not-kgco2e"]) {
      assert.ok(reported.includes(expected), `${expected} was not reported`);
    }
    assert.match(result.reports.find((finding) => finding.code === "w-suffix")!.examples[0]!, /30_300_3000_1_1-w/);
    assert.equal(result.reports.find((finding) => finding.code === "variant-differs"), undefined,
      "a variant at its base's value and unit was reported as differing");
  });
});

describe("refusals", () => {
  it("refuses an unknown source, an unknown scope, a non-numeric or negative factor, and an unmatched country", () => {
    const result = plan([
      row({ db_id: "101", source: "Somebody Else" }),
      row({ db_id: "102", scope: "Scope 4" }),
      row({ db_id: "103", factor: "NaN" }),
      row({ db_id: "104", factor: "-1" }),
      row({ db_id: "105", region: "Narnia" }),
    ]);
    assert.deepEqual(codes(result.refusals), ["bad-factor", "negative-factor", "unknown-country", "unknown-scope", "unknown-source"]);
    assert.equal(result.summary.loaded, 0);
  });

  it("refuses a db_id that appears twice with different content, and one code twice in one dataset", () => {
    assert.deepEqual(codes(plan([row({}), row({ factor: "0.9" })]).refusals), ["db-id-conflict"]);
    assert.deepEqual(codes(plan([row({}), row({ db_id: "999" })]).refusals), ["code-twice-in-dataset"]);
  });

  it("refuses two codes that normalise to one id, and a code reused for a different unit", () => {
    const names = plan([row({ db_id: "201", original_id: "Puerto Rico", source: "IEA 2025", region: "", dataset_id: "52" }),
      row({ db_id: "202", original_id: "puerto rico", source: "IEA 2025", region: "", dataset_id: "52" })]);
    assert.ok(codes(names.refusals).includes("normalisation-collision"));
    const reused = plan([row({ db_id: "301" }), row({ db_id: "302", dataset_id: "9", year: "2024", uom: "litres" })]);
    assert.deepEqual(codes(reused.refusals), ["code-reused"]);
  });

  it("refuses two v7 datasets folding into one family, country and year — with the numbers a ruling needs", () => {
    const result = plan([row({ db_id: "401", dataset_id: "8" }), row({ db_id: "402", dataset_id: "1" }),
      row({ db_id: "403", dataset_id: "1", original_id: "SPEND-1" })]);
    const collision = result.refusals.find((finding) => finding.code === "edition-collision")!;
    assert.match(collision.examples[0]!, /uk-ghg-gb-2025: v7 datasets .* only in .*: 0, only in .*: 1, shared at the same value: 1, shared at a different value: 0/);
  });

  it("merges complementary halves when ruled 'merge': one dataset, a shared code loaded once, both sources recorded", () => {
    const rows = [row({ db_id: "701", dataset_id: "8" }), row({ db_id: "702", dataset_id: "1" }),
      row({ db_id: "703", dataset_id: "1", original_id: "SPEND-1", uom: "GBP", source: "DEFRA" })];
    const merged = plan(rows, { "uk-ghg-gb-2025": "merge" });
    assert.deepEqual(merged.refusals, []);
    assert.deepEqual(merged.datasets.map((dataset) => `${dataset.datasetId}:${dataset.status}:${dataset.legacyDatasetId}`), ["uk-ghg-gb-2025:active:1+8"]);
    assert.deepEqual(merged.factors.map((factor) => factor.legacyDbId).sort(), ["701", "703"], "the shared code was not loaded exactly once, from the lowest lookup row");
    assert.match(merged.reports.find((finding) => finding.code === "merge-duplicate")!.examples[0]!, /db 701 loaded, db 702 not/);
    const conflicting = plan([row({ db_id: "801", dataset_id: "8" }), row({ db_id: "802", dataset_id: "1", factor: "0.9" })], { "uk-ghg-gb-2025": "merge" });
    assert.deepEqual(codes(conflicting.refusals), ["merge-conflict"]);
  });

  it("settles a collision by Francis's precedence ruling, or by a revision marker", () => {
    const rows = [row({ db_id: "501", dataset_id: "8" }), row({ db_id: "502", dataset_id: "1" })];
    const ruled = plan(rows, { "uk-ghg-gb-2025": "8" });
    assert.deepEqual(ruled.refusals, []);
    assert.deepEqual(ruled.datasets.map((dataset) => `${dataset.datasetId}:${dataset.status}:${dataset.legacyDatasetId}`).sort(),
      ["uk-ghg-gb-2025-original:superseded:1", "uk-ghg-gb-2025:active:8"]);
    const revised = plan([row({ db_id: "601", dataset_id: "3", year: "2023", source: "DEFRA" }),
      row({ db_id: "602", dataset_id: "4", year: "2023", source: "DEFRA (2023 Revision)" })]);
    assert.deepEqual(revised.refusals, []);
    assert.equal(revised.datasets.find((dataset) => dataset.status === "active")!.legacyDatasetId, "4", "the revision did not win");
  });
});
