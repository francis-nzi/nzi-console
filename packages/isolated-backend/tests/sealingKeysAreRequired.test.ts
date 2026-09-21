import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { resolveSealingKeys, SealingKeysMissingError, SEALING_KEY_VARIABLES } from "../src/piiSealingKeys";

/**
 * Two properties that were only ever going to be noticed as a broken build (NZC-119).
 *
 * The first: a missing sealing key **refuses the write**. That is the whole design — skipping would let
 * a row land with plaintext and no ciphertext, unencrypted and unerasable, with nothing saying so. It
 * behaved correctly the first time CI met it, and the only evidence was a red check with a stack trace.
 * A property defended by nothing but an outage is a property waiting to be "fixed" by whoever is next
 * inconvenienced by it, so it is asserted here deliberately.
 *
 * The second: a suite that needs a database is actually **run** by the job that has one. Seventeen of
 * twenty-five were not, including the standing encryption check itself — which would have made it a
 * check that never executed, the same family as a date gate that went green over zero files and a
 * privilege test that proved a denial by failing to log in. The tripwire below cannot fix the backlog,
 * but it stops it growing silently.
 *
 * Neither needs a database, which is why they live in the unit suite.
 */

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = resolve(here, "..", "..", "..", ".github", "workflows", "ci.yml");

/**
 * Real-database suites the CI job does not run, recorded rather than hidden.
 *
 * Every name here is a test that exists, passes for whoever has a local Postgres, and proves nothing in
 * CI. Several are load-bearing — tenant isolation, the subject registry, the linkage confinement, the
 * spend-import period pairing — so this is a list to empty, one job step at a time, not a list to live
 * with. It is spelled out so that the gap is a tracked decision and so that a *new* suite cannot join it
 * by accident: adding one fails this test until it is either run by CI or named here with a reason.
 */
const NOT_RUN_IN_CI: ReadonlyArray<string> = [
  "accessProbeReal",
  "activityDistributionStores",
  "aiAssistCommitBoundary",
  "clientCategoryVisibility",
  "clientFactorAlias",
  "dataSubjectRegistry",
  "dateShiftGuards",
  "inputSpecReproducesGolden",
  "jobCreateContract",
  "monthlyAndLabelCharacterisation",
  "reportingChainOrdering",
  "reportLabelSurvivesSync",
  "snapshotOmitsAssetIdentifier",
  "spendImportPeriodPairing",
  "tenantIsolationReal",
];

describe("sealing keys are required, and the suites that need a database are run", () => {
  it("refuses to resolve keys when they are unset, naming every one that is missing", () => {
    // An explicit env rather than mutating `process.env`: the runner sets these for every suite, so
    // deleting them here would be a side effect on whatever runs next in this process.
    assert.throws(() => resolveSealingKeys({}), (error: unknown) => {
      assert.ok(error instanceof SealingKeysMissingError, "a dedicated error, not a generic one");
      for (const variable of Object.values(SEALING_KEY_VARIABLES)) {
        assert.match(error.message, new RegExp(variable),
          `the refusal has to name ${variable}, or whoever hits it cannot act on it`);
      }
      return true;
    });
  });

  it("names the one that is missing when the others are present", () => {
    // The partial case is the one that actually happens — two secrets configured and the third
    // forgotten — and a message that said "keys are missing" would send somebody to check all three.
    const present = {
      [SEALING_KEY_VARIABLES.masterKey]: "a",
      [SEALING_KEY_VARIABLES.indexKey]: "b",
    };
    assert.throws(() => resolveSealingKeys(present), (error: unknown) => {
      assert.ok(error instanceof SealingKeysMissingError);
      assert.match(error.message, new RegExp(SEALING_KEY_VARIABLES.linkageKey));
      assert.doesNotMatch(error.message, new RegExp(SEALING_KEY_VARIABLES.masterKey),
        "it must not name a key that is set");
      return true;
    });
  });

  it("treats whitespace as unset, because a blank secret is a missing one", () => {
    // A secret that failed to interpolate arrives as an empty string, not as an absence. Sealing under
    // "" would throw somewhere deeper and less legibly.
    assert.throws(() => resolveSealingKeys({ ...Object.fromEntries(
      Object.values(SEALING_KEY_VARIABLES).map((variable) => [variable, "   "]),
    ) }), SealingKeysMissingError);
  });

  it("resolves when all three are set", () => {
    // The other half of the pair: a guard that always refuses is not a guard.
    const keys = resolveSealingKeys(Object.fromEntries(
      Object.values(SEALING_KEY_VARIABLES).map((variable) => [variable, `${variable}-value`]),
    ));
    assert.equal(keys.masterKey, `${SEALING_KEY_VARIABLES.masterKey}-value`);
    assert.equal(keys.indexKey, `${SEALING_KEY_VARIABLES.indexKey}-value`);
    assert.equal(keys.linkageKey, `${SEALING_KEY_VARIABLES.linkageKey}-value`);
  });

  it("has every real-database suite either run by CI or named as not run", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    const runByCi = new Set([...workflow.matchAll(/tests\/([A-Za-z0-9]+)\.test\.ts/g)].map((match) => match[1]!));

    // A suite needs a database when it reads the test database URL — the same thing every one of them
    // skips on. The needle is assembled from fragments so that this file does not match itself: a check
    // whose own text trips it is a check that has to be exempted, and an exemption is where the next one
    // hides. Caught by the check on its first run, which is the argument for writing it this way.
    const needle = ["TEST", "DATABASE", "URL"].join("_");
    const needsDatabase = readdirSync(here)
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => name.replace(/\.test\.ts$/, ""))
      .filter((suite) => readFileSync(resolve(here, `${suite}.test.ts`), "utf8").includes(needle));

    // Sanity before judging: if the detection finds nothing, the assertion below passes for the wrong
    // reason. Same refusal as the date gate's floor on files scanned.
    assert.ok(needsDatabase.length >= 20,
      `only ${needsDatabase.length} suites detected as needing a database — the detection is wrong, not the answer`);
    assert.ok(runByCi.has("migrationsRun"), "the workflow scan found no known suite, so it is not reading the workflow");

    const unaccounted = needsDatabase.filter((suite) => !runByCi.has(suite) && !NOT_RUN_IN_CI.includes(suite));
    assert.deepEqual(unaccounted, [],
      "a suite that needs a database and is not run by the migrations job proves nothing in CI. Add a step for it, or name it in NOT_RUN_IN_CI with a reason.");

    // And the list may not outlive its entries: a suite added to CI has to leave it, or the list stops
    // describing anything.
    const stale = NOT_RUN_IN_CI.filter((suite) => runByCi.has(suite) || !needsDatabase.includes(suite));
    assert.deepEqual(stale, [], "NOT_RUN_IN_CI names a suite that CI now runs, or one that no longer exists");
  });
});
