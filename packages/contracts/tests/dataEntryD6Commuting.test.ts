// Data entry D6 (R1, R2a) — employee commuting, pure: a stored commuting detail is exactly the commute (mode, distance, WFH) — no
// commuter name and no registration ride in on it — and a commuting source is labelled by number and mode, never by name.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMMUTING_IDENTIFYING_DETAIL_KEYS, commuterLabel, normaliseCommutingDetail } from "../src/index";

describe("Data entry D6: commuting holds no personal identifier", () => {
  it("R1, R2a: keeps the commute and drops the name, the registration and anything else a caller sends", () => {
    const stored = normaliseCommutingDetail({ commuteMode: "Car — diesel", distanceUnit: "mi", wfhDaysPerYear: 52, wfhHoursPerDay: 7.5,
      employeeName: "Alex Example", vehicleRegistration: "AB12 CDE", plate: "AB12CDE" } as never);
    assert.deepEqual(stored, { kind: "commuting", commuteMode: "Car — diesel", distanceUnit: "mi", wfhDaysPerYear: 52, wfhHoursPerDay: 7.5 });
    assert.doesNotMatch(JSON.stringify(stored), /Alex|AB12/);
  });
  it("keeps the calculation's inputs as they are: no WFH is null, not zero; the unit defaults to km", () => {
    assert.deepEqual(normaliseCommutingDetail({ commuteMode: "Rail", wfhDaysPerYear: null, wfhHoursPerDay: Number.NaN }),
      { kind: "commuting", commuteMode: "Rail", distanceUnit: "km", wfhDaysPerYear: null, wfhHoursPerDay: null });
  });
  it("names the identifying keys the one-off clears", () => {
    assert.deepEqual([...COMMUTING_IDENTIFYING_DETAIL_KEYS], ["employeeName", "vehicleRegistration"]);
  });
  it("R2a: labels a commuter by number and mode", () => {
    assert.equal(commuterLabel(3, "Rail"), "Commuter 3 · Rail");
    assert.equal(commuterLabel(4, null), "Commuter 4");
    assert.equal(commuterLabel(5, "  "), "Commuter 5");
  });
});
