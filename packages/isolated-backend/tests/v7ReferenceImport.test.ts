import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { clean, EXCLUSION_REASONS, normaliseCode, parseCsv, planV7Load, type ExtractRow } from "../src/v7ReferenceImport";
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
  it("reads empty and any spelling of NaN, null or None as absent, in any case, and nothing else", () => {
    for (const absent of ["", "  ", "NaN", "nan", " NAN ", "null", "NULL", "None", "none"]) assert.equal(clean(absent), null);
    for (const kept of ["0", "Nancy", "Null value", "N/A", "Nonetheless"]) assert.equal(clean(kept), kept.trim());
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

  it("matches the extract's spellings the ISO short names miss", () => {
    for (const [name, code] of [["Congo", "CG"], ["Hong Kong, China", "HK"], ["Lao People’s Democratic Rep.", "LA"],
      ["Macedonia, the former Yugoslav Republic of", "MK"], ["Slovak Republic", "SK"], ["Chinese Taipei", "TW"],
      ["Saint Vincent and the Grenadines", "VC"], ["Taiwan (Chinese Taipei)", "TW"]] as const) {
      assert.equal(countryCodeFor(name), code, name);
    }
  });
});

describe("the plan for the synthetic extract", () => {
  const result = plan();

  it("is safe to load: no refusal", () => {
    assert.deepEqual(result.refusals, []);
  });

  it("collapses an identical repeat, excludes a row not in kgCO2e and a retired -w, and loads the rest", () => {
    assert.equal(result.summary.extracted, 18);
    assert.equal(result.summary.duplicatesCollapsed, 1);
    assert.equal(result.summary.skippedNotKgco2e, 1);
    assert.deepEqual(result.excluded.map((row) => row.reason).sort(), ["not-kgco2e", "retired-w"]);
    assert.equal(result.excluded.find((row) => row.reason === "retired-w")!.originalId, "30_300_3000_1_1-w");
    assert.equal(result.factors.length, 15);
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

  it("reports, without refusing: unmapped units, currencies, defaulted countries and a variant with no base", () => {
    const reported = codes(result.reports);
    for (const expected of ["unmapped-unit", "currency-unit", "country-defaulted"]) {
      assert.ok(reported.includes(expected), `${expected} was not reported`);
    }
    // The fixture's baseless variant was its -w row, now excluded; a -b with no base stands in.
    assert.ok(codes(plan([row({ db_id: "151", original_id: "77_700_7000_1_1-b" })]).reports).includes("variant-without-base"));
    assert.equal(result.reports.find((finding) => finding.code === "variant-differs"), undefined,
      "a variant at its base's value and unit was reported as differing");
  });
});

describe("refusals", () => {
  it("refuses an unknown source, an unknown scope, a non-numeric or negative factor, and an unmatched country", () => {
    const result = plan([
      row({ db_id: "101", source: "Somebody Else" }),
      row({ db_id: "102", scope: "Scope 4" }),
      row({ db_id: "103", factor: "0.2x" }),
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
    // 2020 is outside the ruled merges, so the unruled path is what runs.
    const result = plan([row({ db_id: "401", dataset_id: "6", year: "2020" }), row({ db_id: "402", dataset_id: "71", year: "2020" }),
      row({ db_id: "403", dataset_id: "71", year: "2020", original_id: "SPEND-1" })]);
    const collision = result.refusals.find((finding) => finding.code === "edition-collision")!;
    assert.match(collision.examples[0]!, /uk-ghg-gb-2020: v7 datasets .* only in .*: 0, only in .*: 1, shared at the same value: 1, shared at a different value: 0/);
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
    const revised = plan([row({ db_id: "601", dataset_id: "6", year: "2020", source: "DEFRA" }),
      row({ db_id: "602", dataset_id: "71", year: "2020", source: "DEFRA (2020 Revision)" })]);
    assert.deepEqual(revised.refusals, []);
    assert.equal(revised.datasets.find((dataset) => dataset.status === "active")!.legacyDatasetId, "71", "the revision did not win");
  });
});

describe("the rulings of 25 Sep 2026", () => {
  it("merges each uk-ghg and nzi year 2021–2026 from its two v7 datasets by default, with no precedence file", () => {
    for (const source of ["DESNZ", "NZI"] as const) {
      for (const [year, a, b] of [["2021", "12", "5"], ["2022", "11", "4"], ["2023", "10", "3"], ["2024", "9", "2"], ["2025", "8", "1"], ["2026", "70", "69"]] as const) {
        const result = plan([row({ db_id: `${year}1`, dataset_id: a, year, source }), row({ db_id: `${year}2`, dataset_id: b, year, source, original_id: "SPEND-1" })]);
        assert.deepEqual(result.refusals, [], `${source} ${year} was not merged`);
        const family = source === "NZI" ? "nzi" : "uk-ghg";
        assert.deepEqual(result.datasets.map((dataset) => `${dataset.datasetId}:${dataset.status}:${dataset.legacyDatasetId}`),
          [`${family}-gb-${year}:active:${[a, b].sort((x, y) => Number(x) - Number(y)).join("+")}`]);
      }
    }
  });

  it("still refuses a ruled merge whose halves price or scope a shared code differently", () => {
    const priced = plan([row({ db_id: "911", dataset_id: "8" }), row({ db_id: "912", dataset_id: "1", factor: "0.9" })]);
    assert.deepEqual(codes(priced.refusals), ["merge-conflict"]);
    const scoped = plan([row({ db_id: "913", dataset_id: "8" }), row({ db_id: "914", dataset_id: "1", scope: "Scope 3" })]);
    assert.deepEqual(codes(scoped.refusals), ["merge-conflict"]);
  });

  it("lets a precedence file override a ruled merge for its slug", () => {
    const result = plan([row({ db_id: "921", dataset_id: "8" }), row({ db_id: "922", dataset_id: "1" })], { "uk-ghg-gb-2025": "8" });
    assert.deepEqual(result.datasets.map((dataset) => dataset.status).sort(), ["active", "superseded"]);
  });

  it("refuses a ceda row with no region, excludes an swc one, and counts empty regions per family", () => {
    const result = plan([
      row({ db_id: "931", source: "CEDA 2025 (Watershed)", region: "", original_id: "561600", uom: "USD" }),
      row({ db_id: "932", source: "SWC (Small World Consulting)", region: "null", original_id: "SWC-1", uom: "GBP" }),
      row({ db_id: "933", source: "DESNZ", region: "" }),
    ]);
    assert.equal(result.refusals.find((finding) => finding.code === "no-country")!.count, 1);
    assert.deepEqual(result.excluded.map((excluded) => `${excluded.dbId}:${excluded.reason}`), ["932:swc-no-country"]);
    assert.deepEqual(result.summary.emptyRegionByFamily, { "uk-ghg": 1, iea: 0, ceda: 1, ice: 0, swc: 1, nzi: 0 });
  });

  it("excludes every swc row with no region and counts them, rather than erroring or blocking", () => {
    const swc = Array.from({ length: 4 }, (_, index) =>
      row({ db_id: `95${index}`, source: "SWC", region: "", original_id: `SWC-${index}`, uom: "GBP" }));
    const result = plan(swc);
    assert.deepEqual(result.refusals, []);
    assert.equal(result.exclusions.find((finding) => finding.code === "swc-no-country")!.count, 4);
    assert.equal(result.summary.emptyRegionByFamily.swc, 4);
    assert.equal(result.factors.length, 0);
  });

  it("defaults uk-ghg and nzi to GB and ice to GLOBAL, reporting each", () => {
    const result = plan([
      row({ db_id: "941", source: "NZI", region: "", original_id: "99_1" }),
      row({ db_id: "942", source: "RICS / BRE ICE Database V4.1 (Oct 2025)", region: "", original_id: "7", uom: "kg", year: "2026" }),
    ]);
    assert.deepEqual(result.refusals, []);
    assert.deepEqual(result.datasets.map((dataset) => `${dataset.datasetId}:${dataset.countryCode}`).sort(), ["ice-global-2026:GLOBAL", "nzi-gb-2025:GB"]);
    assert.equal(result.reports.find((finding) => finding.code === "country-defaulted")!.count, 2);
  });
});

describe("the full-extract review of 25 Sep 2026", () => {
  it("nulls every spelling of null in any case, so one code's category is stable, and counts what it nulled", () => {
    const result = plan([
      row({ db_id: "961", dataset_id: "5", year: "2021", level_2: "Green gas", level_3: "NaN", level_4: "" }),
      row({ db_id: "962", dataset_id: "5", year: "2022", level_2: "Green gas", level_3: "nan", level_4: "None" }),
      row({ db_id: "963", dataset_id: "5", year: "2023", level_2: "Green gas", level_3: "", level_4: "NULL" }),
    ]);
    assert.deepEqual(result.refusals, []);
    assert.deepEqual(result.factors.map((factor) => factor.sourceLevels.join("|")), Array(3).fill("Passenger vehicles|Green gas"));
    assert.deepEqual(result.summary.nulledCells, { NaN: 1, nan: 1, None: 1, NULL: 1 });
    assert.equal(result.summary.rowsWithNulledCells, 3);
  });

  it("loads -cv as the registered -vcp variant, keeping v7's code verbatim, and reports it", () => {
    const result = plan([row({ db_id: "971", original_id: "10_100_1000_1_1-cv", scope: "Scope 1", category: "Company Vehicles" })]);
    assert.deepEqual(result.refusals, []);
    const factor = result.factors[0]!;
    assert.equal(factor.factorId, "uk-ghg-10_100_1000_1_1-vcp");
    assert.equal(factor.legacyOriginalId, "10_100_1000_1_1-cv");
    assert.equal(result.identities[0]!.legacyOriginalId, "10_100_1000_1_1-cv");
    assert.match(result.reports.find((finding) => finding.code === "suffix-aliased")!.examples[0]!, /971: 10_100_1000_1_1-cv → 10_100_1000_1_1-vcp/);
  });

  it("excludes a row with no factor — NaN in any case — as factor-missing, and refuses one that is not a number", () => {
    const result = plan([row({ db_id: "981", factor: "NaN" }), row({ db_id: "982", original_id: "X_1", factor: "nan" }),
      row({ db_id: "983", original_id: "X_2", factor: "" }), row({ db_id: "984", original_id: "X_3", factor: "abc" })]);
    assert.equal(result.exclusions.find((finding) => finding.code === "factor-missing")!.count, 3);
    assert.equal(result.refusals.find((finding) => finding.code === "bad-factor")!.count, 1);
  });

  it("excludes a column-shifted row: a currency that is not a currency code", () => {
    const result = plan([
      row({ db_id: "991", original_id: "SPEND-SIC-49.1-2-b", currency: "Rail transport services", uom: "GBP", source: "DEFRA" }),
      row({ db_id: "992", original_id: "SPEND-1", currency: "GBP", uom: "GBP", source: "DEFRA" }),
    ]);
    assert.deepEqual(result.refusals, []);
    const shifted = result.exclusions.find((finding) => finding.code === "column-shifted")!;
    assert.equal(shifted.count, 1);
    assert.match(shifted.examples[0]!, /^991: SPEND-SIC-49\.1-2-b currency "Rail transport services"/);
    assert.equal(result.factors.length, 1);
  });

  it("reads a bare scope number as that scope, and reports it", () => {
    const result = plan([row({ db_id: "1001", original_id: "SPEND-SIC-49.3-5-u", scope: "3", uom: "GBP", source: "DEFRA" })]);
    assert.deepEqual(result.refusals, []);
    assert.deepEqual(result.factors[0]!.scopes, ["3"]);
    assert.equal(result.reports.find((finding) => finding.code === "scope-normalised")!.count, 1);
  });

  it("places each IEA row in the country its code names — never the GLOBAL default — and refuses one it cannot match", () => {
    const iea = (dbId: string, code: string) =>
      row({ db_id: dbId, original_id: code, source: "IEA 2025", region: "", dataset_id: "48", scope: "Scope 2", uom: "kWh" });
    const result = plan([iea("1011", "Algeria"), iea("1012", "Argentina"), iea("1013", "Taiwan (Chinese Taipei)")]);
    assert.deepEqual(result.refusals, []);
    assert.deepEqual(result.datasets.map((dataset) => dataset.countryCode).sort(), ["AR", "DZ", "TW"]);
    assert.equal(result.reports.find((finding) => finding.code === "country-defaulted"), undefined);
    assert.deepEqual(codes(plan([iea("1014", "Narnia")]).refusals), ["unknown-country"]);
  });
});

describe("the dry-run rulings of 25 Sep 2026", () => {
  it("excludes only the five named reasons; any other bad row still refuses the whole load", () => {
    assert.deepEqual(Object.keys(EXCLUSION_REASONS).sort(), ["column-shifted", "factor-missing", "not-kgco2e", "retired-w", "swc-no-country"]);
    const result = plan([
      row({ db_id: "1101", factor: "NaN" }),
      row({ db_id: "1102", original_id: "X_1", currency: "Rail transport services" }),
      row({ db_id: "1103", original_id: "SWC-1", source: "SWC", region: "", uom: "GBP" }),
      row({ db_id: "1104", original_id: "X_2", ghg_unit: "kWh(net)" }),
      row({ db_id: "1105", original_id: "X_3-w" }),
      row({ db_id: "1106", original_id: "X_4" }),
    ]);
    assert.deepEqual(result.refusals, []);
    assert.deepEqual(result.excluded.map((excluded) => `${excluded.dbId}:${excluded.reason}`),
      ["1101:factor-missing", "1102:column-shifted", "1103:swc-no-country", "1104:not-kgco2e", "1105:retired-w"]);
    assert.deepEqual(result.factors.map((factor) => factor.legacyDbId), ["1106"]);
    assert.equal(result.summary.loaded, 1, "a plan with exclusions and no refusal was not loadable");
    const halted = plan([row({ db_id: "1111", factor: "NaN" }), row({ db_id: "1112", original_id: "X_5", scope: "Scope 4" })]);
    assert.deepEqual(codes(halted.refusals), ["unknown-scope"]);
    assert.equal(halted.summary.loaded, 0);
  });

  it("loads a negative ICE factor and reports it, and refuses a negative anywhere else", () => {
    const ice = plan([row({ db_id: "1201", source: "RICS / BRE ICE Database V4.1 (Oct 2025)", original_id: "526", factor: "-1.03089278",
      uom: "kg", year: "2026", region: "", scope: "Scope 3" })]);
    assert.deepEqual(ice.refusals, []);
    assert.equal(ice.factors[0]!.kgco2ePerUnit, "-1.03089278");
    assert.equal(ice.reports.find((finding) => finding.code === "ice-negative")!.count, 1);
    for (const source of ["DESNZ", "CEDA 2025 (Watershed)", "IEA 2025", "NZI"]) {
      const other = plan([row({ db_id: "1202", source, factor: "-0.5", region: "United Kingdom" })]);
      assert.deepEqual(codes(other.refusals), ["negative-factor"], source);
    }
  });

  it("lets a code's scope vary by year: each value row keeps its own, the identity carries the union", () => {
    const result = plan([
      row({ db_id: "1301", original_id: "SPEND-SIC-05", source: "DEFRA", uom: "GBP", dataset_id: "2", year: "2024", scope: "Scope 3" }),
      row({ db_id: "1302", original_id: "SPEND-SIC-05", source: "DEFRA", uom: "GBP", dataset_id: "1", year: "2025", scope: "Scope 1" }),
    ]);
    assert.deepEqual(result.refusals, []);
    assert.deepEqual(result.factors.map((factor) => `${factor.datasetId}:${factor.scopes.join("+")}`).sort(), ["uk-ghg-gb-2024:3", "uk-ghg-gb-2025:1"]);
    assert.deepEqual(result.identities[0]!.scopes, ["1", "3"]);
    assert.match(result.reports.find((finding) => finding.code === "scope-by-year")!.examples[0]!, /uk-ghg-SPEND-SIC-05: 2024 S3, 2025 S1/);
  });
});
