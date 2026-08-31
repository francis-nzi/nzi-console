import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { yoyVarianceNote } from "../app/jobs/yoyVariance";

describe("yoyVarianceNote", () => {
  it("flags a large increase with the multiple and the prior value", () => {
    assert.equal(yoyVarianceNote(3900, 1240, "GBP"), "3.1× last year (was 1,240 GBP)");
  });

  it("flags a large decrease as a percentage of last year", () => {
    assert.equal(yoyVarianceNote(300, 1240, "GBP"), "24% of last year (was 1,240 GBP)");
  });

  it("stays quiet within the 50%–200% band", () => {
    assert.equal(yoyVarianceNote(1240, 1240, "GBP"), null);
    assert.equal(yoyVarianceNote(1800, 1240, "GBP"), null);
    assert.equal(yoyVarianceNote(700, 1240, "GBP"), null);
  });

  it("returns null when a value is missing or the prior is not positive", () => {
    assert.equal(yoyVarianceNote(null, 1240, "GBP"), null);
    assert.equal(yoyVarianceNote(3900, null, "GBP"), null);
    assert.equal(yoyVarianceNote(3900, 0, "GBP"), null);
  });

  it("omits the unit when there is none", () => {
    assert.equal(yoyVarianceNote(5000, 1000, null), "5.0× last year (was 1,000)");
  });
});
