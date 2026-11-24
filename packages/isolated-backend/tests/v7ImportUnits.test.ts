import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normaliseV7Unit, sameV7Unit, v7PlanUnitRefusal, v7UnitAgainstFactor } from "../src/v7Reingest";

/**
 * The import's one unit rule (J000434's refused bring-in, 24 Nov: "v7-row-10357/10358: the plan's unit kWh (Gross CV) is not v7's
 * kWh"). The rows modal judged the unit one way (v7's normalised unit against the factor's), the plan builder another (v7's raw
 * uom), and the final check a third — so a row the modal called ready was refused. Now one rule: a bare kWh is kWh (Gross CV),
 * never kWh (Net CV); the plan builder and the matcher both read v7UnitAgainstFactor; the final check reads v7PlanUnitRefusal.
 */
// v7's uoms as its rows hold them, and the console factors' units, including the spellings the live check found.
const V7_UOMS = ["kWh", "kWh (Gross CV)", "kwh (gross cv)", "KWH (GROSS CV)", "kWh (Net CV)", "kwh (net cv)", "kWh(Net CV)", "litres", "miles", "km", "cubic metres",
  "m3", "tonnes", "tonne", "kg", "passenger.km", "tonne.km", "GJ", "each", "unit", "room per night", "gbp", "GBP", "eur", "tCO2e", "Unlisted thing", null];
const FACTOR_UNITS = ["kWh", "kWh (Gross CV)", "kWh (Net CV)", "litres", "miles", "km", "m3", "tonnes", "kg", "passenger.km", "tonne.km", "GJ", "units", "nights",
  "GBP", "EUR", "kgCO2e/km", "tCO2e", "Unlisted thing", null];

describe("energy's calorific basis: a bare kWh is gross CV, never net", () => {
  it("kWh is kWh (Gross CV), either way round, any case or spacing; kWh (Net CV) is only itself", () => {
    for (const gross of ["kWh (Gross CV)", "kwh (gross cv)", " KWH  (GROSS CV) ", "kWh(Gross CV)"]) {
      assert.ok(sameV7Unit("kWh", gross) && sameV7Unit(gross, "kWh"), gross);
    }
    for (const net of ["kWh (Net CV)", "kwh (net cv)", "kWh(Net CV)"]) {
      assert.ok(!sameV7Unit("kWh", net) && !sameV7Unit(net, "kWh"), net);
      assert.ok(!sameV7Unit("kWh (Gross CV)", net), `gross is not ${net}`);
      assert.ok(sameV7Unit("kWh (Net CV)", net), `${net} is itself`);
    }
  });
  it("v7's net CV is kept net where it is read: the registry map had read both CVs as a bare kWh", () => {
    assert.equal(normaliseV7Unit("kWh (Gross CV)"), "kWh");
    assert.equal(normaliseV7Unit("kWh (Net CV)"), "kWh (Net CV)");
    assert.equal(normaliseV7Unit("kwh (net cv)"), "kWh (Net CV)");
    assert.equal(normaliseV7Unit("cubic metres"), "m3", "the rest of the map as it was");
  });
});

describe("one rule from the modal to the final check", () => {
  it("J000434's 10357/10358: natural gas held in kWh (Gross CV), on a factor in kWh — the same unit, carried in the factor's spelling, not refused", () => {
    const unit = v7UnitAgainstFactor("kWh (Gross CV)", "kWh");
    assert.deepEqual(unit, { planUnit: "kWh", sameUnit: true, refusal: null });
    assert.equal(v7PlanUnitRefusal(unit.planUnit, normaliseV7Unit("kWh (Gross CV)")), null);
  });
  it("net CV on a factor in kWh: not the same unit, and bringing it in is refused — said before, in the modal", () => {
    const unit = v7UnitAgainstFactor("kWh (Net CV)", "kWh");
    assert.equal(unit.sameUnit, false);
    assert.match(unit.refusal ?? "", /kWh \(Net CV\).*priced per kWh.*refused/);
  });
  it("for every v7 unit and every factor unit: a candidate the modal can bring in — the same unit, or one priced per it — is never refused on its unit by the final check", () => {
    let pairs = 0;
    for (const uom of V7_UOMS) for (const factorUnit of FACTOR_UNITS) {
      const unit = v7UnitAgainstFactor(uom, factorUnit);
      if (unit.refusal !== null) continue;
      pairs += 1;
      assert.equal(v7PlanUnitRefusal(unit.planUnit, normaliseV7Unit(uom)), null, `${uom} on a factor in ${factorUnit}: the modal would bring it in, and the final check refuses it`);
      if (unit.sameUnit) assert.equal(unit.planUnit, factorUnit, `${uom} on ${factorUnit}: the same unit is carried in the factor's spelling, so calculation reads them as one`);
    }
    assert.ok(pairs > 40, `${pairs} pairs checked`);
  });
  it("the same unit is the same whichever spelling of v7's unit is compared — raw, or as the final check normalises it", () => {
    for (const uom of V7_UOMS) for (const factorUnit of FACTOR_UNITS) {
      if (uom === null || factorUnit === null) continue;
      const held = normaliseV7Unit(uom)!;
      assert.equal(sameV7Unit(factorUnit, held), v7UnitAgainstFactor(uom, factorUnit).sameUnit, `${uom} / ${factorUnit}`);
    }
  });
  it("net CV is never carried onto a factor in another energy unit, and never onto a bare kWh", () => {
    for (const factorUnit of ["kWh", "kWh (Gross CV)", "GJ"]) {
      assert.notEqual(v7UnitAgainstFactor("kWh (Net CV)", factorUnit).refusal, null, factorUnit);
      assert.notEqual(v7UnitAgainstFactor("kWh", "kWh (Net CV)").refusal, null);
    }
    assert.deepEqual(v7UnitAgainstFactor("kWh (Net CV)", "kWh (Net CV)"), { planUnit: "kWh (Net CV)", sameUnit: true, refusal: null });
  });
});
