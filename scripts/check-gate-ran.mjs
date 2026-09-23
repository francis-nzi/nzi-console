#!/usr/bin/env node
/**
 * The capture gate ran, and ran everything (NZC-147).
 *
 * ## Why a gate needs a guard of its own
 *
 * Playwright exits 0 when it has nothing to do. It exits 0 when every test is skipped. It exits 0 when a
 * stray `test.only` has narrowed the run to a single case. In all three the check is green and the suite
 * asserted nothing — and this is not hypothetical here: the acceptance suite this gate sits beside writes an
 * empty storage state and annotates a skip when its credentials are absent, so wiring *that* into CI without
 * secrets would have produced a permanently green step that executed zero browser tests.
 *
 * That is the recurring defect in this codebase rather than a new one: a catch-all that swallows the case it
 * was meant to catch, a CHECK constraint that admits NULL, a capability nobody asked for, a fallback that
 * reopened a drawer. The common shape is a check whose failure is indistinguishable from its success.
 *
 * So the gate's result file is read, and the run is refused unless it actually executed the tests. The
 * expected count is declared rather than inferred: inferring it from the file means the number always
 * matches, which is the same non-check again. Adding a test to the gate means raising `EXPECTED` here, on
 * purpose, in the same commit.
 */

import { readFileSync } from "node:fs";

const RESULTS = "apps/console/test-results/gate-results.json";

/**
 * How many tests the gate must run. Raise this when you add one.
 *
 * It is a floor rather than an equality so that adding a test does not fail the build before the number is
 * updated — but it is checked, so deleting one does.
 */
const EXPECTED = 6;

const fail = (message) => { console.error(`✗ capture gate: ${message}`); process.exit(1); };

let report;
try {
  report = JSON.parse(readFileSync(RESULTS, "utf8"));
} catch (error) {
  fail(`no result file at ${RESULTS} — the run produced no report at all (${error.message})`);
}

/** Playwright nests suites; the specs carry the outcomes. */
const specs = [];
const walk = (suite) => {
  for (const spec of suite.specs ?? []) specs.push(spec);
  for (const child of suite.suites ?? []) walk(child);
};
for (const suite of report.suites ?? []) walk(suite);

const outcomes = specs.flatMap((spec) => (spec.tests ?? []).map((test) => test.status ?? "unknown"));
const ran = outcomes.filter((status) => status !== "skipped").length;
const skipped = outcomes.filter((status) => status === "skipped").length;

if (specs.length === 0) fail("the report contains no tests — nothing was executed");
if (skipped > 0) {
  fail(`${skipped} test(s) skipped. The gate has no conditional cases: a skip means it could not run, `
    + "and a green step that could not run is the defect this guard exists to catch.");
}
if (ran < EXPECTED) {
  fail(`only ${ran} test(s) ran, expected at least ${EXPECTED}. Either a test was deleted, or a `
    + "`test.only` narrowed the run.");
}

console.log(`✓ capture gate: ${ran} browser tests ran, none skipped (floor ${EXPECTED})`);
