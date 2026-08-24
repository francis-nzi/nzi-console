import assert from "node:assert/strict";
import test from "node:test";
import { findJob, formatJobNumber, jobs } from "../src/jobs";

test("official job numbers use J plus six zero-padded digits", () => {
  assert.equal(formatJobNumber(0), "J000000");
  assert.equal(formatJobNumber(612), "J000612");
  assert.equal(formatJobNumber(999999), "J999999");
});

test("invalid sequences are rejected", () => {
  assert.throws(() => formatJobNumber(-1), RangeError);
  assert.throws(() => formatJobNumber(1.5), RangeError);
  assert.throws(() => formatJobNumber(1000000), RangeError);
});

test("job family is separate from the official number", () => {
  const families = new Set(jobs.map((job) => job.header.family));
  assert.deepEqual([...families].sort(), ["consultancy", "crp", "lca", "pcf", "training"]);
  assert.ok(jobs.every((job) => /^J\d{6}$/.test(job.header.number)));
  assert.ok(jobs.every((job) => !job.header.number.includes(job.header.family.toUpperCase())));
});

test("jobs can be resolved by internal id or official number", () => {
  assert.equal(findJob("712")?.header.number, "J000712");
  assert.equal(findJob("j000716")?.header.family, "training");
});
