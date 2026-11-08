// Employee commuting (3.7) per-site sample uplift (BRIEF-commuting-uplift-lean), pure: the arithmetic and every edge rule.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMMUTING_UPLIFT_METHOD_LINE, computeSiteUplift, upliftedFigure, upliftFlagText, type SiteUpliftInput } from "../src/index";

const site = (patch: Partial<SiteUpliftInput> = {}): SiteUpliftInput => ({ employees: 100, companyCarUsers: 10, respondents: 54, enabled: true, agreedHeadcount: null, ...patch });
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} vs ${expected}`);

describe("commuting uplift: the worked case", () => {
  it("E=100, C=10, R=54: eligible 90, default U=36, f=90/54, response rate 60%", () => {
    const uplift = computeSiteUplift(site());
    assert.equal(uplift.eligible, 90);
    assert.equal(uplift.defaultHeadcount, 36);
    assert.equal(uplift.headcount, 36);
    close(uplift.factor, 90 / 54);
    close(uplift.factor, 1.6666666666666667);
    close(uplift.responseRate!, 0.6);
    assert.equal(uplift.applied, true);
    assert.deepEqual(uplift.flags, []);
  });

  it("scales a site's sampled figure by f, and the sites sum", () => {
    const a = computeSiteUplift(site());
    const b = computeSiteUplift(site({ employees: 40, companyCarUsers: 0, respondents: 20 })); // U=20, f=2
    close(b.factor, 2);
    close(upliftedFigure(54, a) + upliftedFigure(10, b), 54 * (90 / 54) + 20);
  });

  it("the client's agreed headcount replaces the default", () => {
    const uplift = computeSiteUplift(site({ agreedHeadcount: 20 }));
    assert.equal(uplift.headcount, 20);
    close(uplift.factor, (54 + 20) / 54);
  });
});

describe("commuting uplift: edge rules", () => {
  it("is OFF unless switched on: sampled figures stand and the factor is not applied", () => {
    const uplift = computeSiteUplift(site({ enabled: false }));
    assert.equal(uplift.applied, false);
    assert.equal(uplift.factor, 1);
    assert.equal(upliftedFigure(54, uplift), 54);
  });

  it("R = 0: uplift is unavailable (nothing to scale), even when switched on", () => {
    const uplift = computeSiteUplift(site({ respondents: 0 }));
    assert.deepEqual([uplift.available, uplift.applied, uplift.unavailableReason, uplift.factor, uplift.headcount], [false, false, "no-respondents", 1, null]);
  });

  it("no employees entered: unavailable until they are", () => {
    const uplift = computeSiteUplift(site({ employees: null }));
    assert.deepEqual([uplift.available, uplift.applied, uplift.unavailableReason], [false, false, "no-employees"]);
  });

  it("U = 0 (everyone eligible answered): f = 1, an explicit no-op that is still 'applied'", () => {
    const uplift = computeSiteUplift(site({ employees: 64, companyCarUsers: 10, respondents: 54 }));
    assert.equal(uplift.headcount, 0);
    assert.equal(uplift.factor, 1);
    assert.equal(uplift.applied, true);
  });

  it("respondents exceed eligible: default U=0, the site is flagged, and nothing is scaled down", () => {
    const uplift = computeSiteUplift(site({ employees: 50, companyCarUsers: 10, respondents: 54 }));
    assert.equal(uplift.defaultHeadcount, 0);
    assert.equal(uplift.factor, 1);
    assert.deepEqual(uplift.flags, ["respondents-exceed-eligible"]);
    assert.match(upliftFlagText("respondents-exceed-eligible"), /check employees \/ company-car count/);
  });

  it("an agreed headcount above the not-surveyed count is allowed, and flagged", () => {
    const uplift = computeSiteUplift(site({ agreedHeadcount: 50 }));
    assert.equal(uplift.headcount, 50);
    assert.deepEqual(uplift.flags, ["uplift-above-unsurveyed"]);
  });

  it("company-car staff leave the eligible population: dropping C from E-C changes the total", () => {
    assert.equal(computeSiteUplift(site({ companyCarUsers: 0 })).defaultHeadcount, 46);
    assert.equal(computeSiteUplift(site({ companyCarUsers: 10 })).defaultHeadcount, 36);
  });

  it("only whole, non-negative headcounts count", () => {
    const uplift = computeSiteUplift(site({ employees: 100.9, companyCarUsers: -4, respondents: 54 }));
    assert.equal(uplift.eligible, 100);
  });

  it("the method line states the limit of the method", () => {
    assert.match(COMMUTING_UPLIFT_METHOD_LINE, /representative/);
  });
});
