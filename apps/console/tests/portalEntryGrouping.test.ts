import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPortalDataEntryAccordion, portalBucketCode, type PortalBucket } from "../app/portal/portalEntryGrouping";

const bucket = (over: Partial<PortalBucket> = {}): PortalBucket => ({
  bucketGrantId: "b1", scopeRowId: "r1", scope: "3.1", categoryCode: null, sourceLabel: "Bucket",
  entryKind: "manual_activity", factors: [], sites: [], units: [], pgsCategories: [], ...over,
});

describe("portalBucketCode", () => {
  it("uses the stamped category_code, else the scope string, else the top-level scope", () => {
    assert.equal(portalBucketCode(bucket({ categoryCode: "3.7" })), "3.7");
    assert.equal(portalBucketCode(bucket({ scope: "3.1", categoryCode: null })), "3.1");
    assert.equal(portalBucketCode(bucket({ scope: "1", categoryCode: null })), "1");
    assert.equal(portalBucketCode(bucket({ scope: "1", categoryCode: "9.99" })), "1");
  });
});

describe("buildPortalDataEntryAccordion", () => {
  it("groups authorised buckets into taxonomy-named sections, ordered by scope", () => {
    const sections = buildPortalDataEntryAccordion([
      bucket({ bucketGrantId: "b-spend", scope: "3.1", categoryCode: "3.1", entryKind: "spend" }),
      bucket({ bucketGrantId: "b-commute", scope: "3.7", categoryCode: "3.7", entryKind: "commuting" }),
      bucket({ bucketGrantId: "b-gas", scope: "1", categoryCode: "1.natural-gas", entryKind: "manual_activity" }),
    ]);
    assert.deepEqual(sections.map(section => section.name), ["Natural Gas", "Purchased Goods and Services", "Employee Commuting"]);
    assert.deepEqual(sections.map(section => section.scope), ["1", "3", "3"]);
    assert.equal(sections.find(section => section.code === "3.1")!.kind, "spend");
    assert.equal(sections.find(section => section.code === "3.7")!.kind, "commuting");
  });

  it("splits spend and non-spend buckets within a section, and never drops a bucket", () => {
    const sections = buildPortalDataEntryAccordion([
      bucket({ bucketGrantId: "b-spend", scope: "3.1", categoryCode: "3.1", entryKind: "spend" }),
      bucket({ bucketGrantId: "b-manual", scope: "3.1", categoryCode: "3.1", entryKind: "manual_activity" }),
    ]);
    const pgs = sections.find(section => section.code === "3.1")!;
    assert.equal(pgs.buckets.length, 2);
    assert.deepEqual(pgs.spendBuckets.map(b => b.bucketGrantId), ["b-spend"]);
    assert.deepEqual(pgs.otherBuckets.map(b => b.bucketGrantId), ["b-manual"]);
  });

  it("falls back to a scope-labelled section for an un-coded Scope 1 bucket", () => {
    const sections = buildPortalDataEntryAccordion([bucket({ scope: "1", categoryCode: null, entryKind: "vehicle" })]);
    assert.equal(sections.length, 1);
    assert.equal(sections[0]!.code, "1");
    assert.match(sections[0]!.name, /Scope 1/);
    assert.equal(sections[0]!.kind, "vehicle");
  });
});
