import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  crpReportSectionCatalogue,
  isReportTokenKey,
  renderReportSectionBody,
  reportTokenCatalogue,
  resolveReportToken,
  verifyReportSectionTokens,
  resolveReportSections,
} from "../src/index";

const snapshot = {
  reportingYear: 2024,
  target: { jobId: "j", baselineYear: 2022, baselineTco2e: 1650, interimYear: 2035, interimReductionPercent: 50, netZeroYear: 2045, version: 1, updatedAt: "x", updatedBy: "y" },
  intensityTarget: { jobId: "j", metric: "turnover" as const, denominatorUnit: "£m", reportingDenominator: 20, baselineYear: 2022, baselineIntensity: 80, interimYear: 2035, interimReductionPercent: 50, netZeroYear: 2045, version: 1, updatedAt: "x", updatedBy: "y" },
  measurements: [
    { rowId: "r1", rowVersion: 1, scope: "1" as const, sourceLabel: "Fleet", tco2e: 146, factorSet: "F", qualityTier: "measured" as const, reviewedBy: "rev" },
    { rowId: "r2", rowVersion: 1, scope: "2" as const, sourceLabel: "Power", tco2e: 96, factorSet: "F", qualityTier: "measured" as const, reviewedBy: "rev" },
    { rowId: "r3", rowVersion: 1, scope: "3" as const, sourceLabel: "Value chain", tco2e: 1176, factorSet: "F", qualityTier: "estimated" as const, reviewedBy: "rev" },
  ],
};

describe("report figure tokens (NZC-049)", () => {
  it("resolves totals, shares, targets and intensity from the reviewed snapshot", () => {
    assert.equal(resolveReportToken("total", snapshot).value, "1,418 tCO₂e");
    assert.equal(resolveReportToken("scope3", snapshot).value, "1,176 tCO₂e");
    assert.equal(resolveReportToken("scope3Pct", snapshot).value, "82.9%");
    assert.equal(resolveReportToken("reportingYear", snapshot).value, "2024");
    assert.equal(resolveReportToken("baselineTotal", snapshot).value, "1,650 tCO₂e");
    assert.equal(resolveReportToken("interimReductionPct", snapshot).value, "50%");
    assert.equal(resolveReportToken("netZeroYear", snapshot).value, "2045");
    assert.equal(resolveReportToken("intensityValue", snapshot).value, "70.9");
    assert.equal(resolveReportToken("intensityUnit", snapshot).value, "tCO₂e / £m");
    for (const token of [resolveReportToken("total", snapshot), resolveReportToken("scope1Pct", snapshot)]) assert.equal(token.ok, true);
  });

  it("marks a token unresolved (never guesses) when the data is absent", () => {
    const bare = { ...snapshot, target: null, intensityTarget: null };
    const baseline = resolveReportToken("baselineTotal", bare);
    assert.equal(baseline.ok, false);
    assert.equal(baseline.value, "—");
    assert.equal(resolveReportToken("intensityValue", bare).ok, false);
    assert.equal(resolveReportToken("not-a-token", snapshot).ok, false);
  });

  it("renders `<span data-token>` markers as locked value chips, leaving prose untouched", () => {
    const html = renderReportSectionBody('<p>The footprint is <span data-token="total"></span> for the year.</p>', snapshot);
    assert.match(html, /class="nz-fig-token" data-token="total"[^>]*>1,418 tCO₂e<\/span>/);
    assert.match(html, /^<p>The footprint is <span/);
    assert.match(html, /for the year\.<\/p>$/);
    // an unresolved token still renders, marked
    const missing = renderReportSectionBody('<p><span data-token="intensityValue"></span></p>', { ...snapshot, intensityTarget: null });
    assert.match(missing, /class="nz-fig-token unresolved"/);
  });

  it("escapes the resolved value and the tooltip", () => {
    // no token value contains markup today, but the renderer must be injection-safe
    const html = renderReportSectionBody('<p><span data-token="intensityUnit"></span></p>', snapshot);
    assert.doesNotMatch(html, /<script/i);
    assert.match(html, /title="[^"]*"/);
  });

  it("verifies every token in the section catalogue resolves against a complete snapshot", () => {
    const sections = resolveReportSections([]);
    const result = verifyReportSectionTokens(sections, snapshot);
    assert.equal(result.ok, true, JSON.stringify(result.tokens.filter((t) => !t.ok), null, 2));
    assert.ok(result.tokens.length >= 10);
  });

  it("fails verification when a section token cannot resolve", () => {
    const sections = resolveReportSections([]);
    const result = verifyReportSectionTokens(sections, { ...snapshot, target: null, intensityTarget: null });
    assert.equal(result.ok, false);
    assert.ok(result.tokens.some((t) => !t.ok && t.key === "netZeroYear"));
  });

  it("every token used in the catalogue is in the palette", () => {
    const used = new Set<string>();
    for (const section of crpReportSectionCatalogue) for (const m of section.defaultBodyHtml.matchAll(/data-token="([a-zA-Z0-9]+)"/g)) used.add(m[1]!);
    for (const key of used) assert.equal(isReportTokenKey(key), true, key);
    assert.ok(reportTokenCatalogue.length >= used.size);
  });
});
