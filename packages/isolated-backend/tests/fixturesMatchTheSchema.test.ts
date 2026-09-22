import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * Every `nzi_console.*` a suite names must be something a migration creates.
 *
 * Written because a fixture selected a role id from a `roles` table that has never existed in this
 * schema — `memberships.role_id` is text governed by a CHECK, and there is no lookup table behind it.
 * The suite typechecked, passed locally by skipping for want of a database, and failed in CI as
 * `relation … does not exist` inside a `before` hook, which cancels every test in the file. Six
 * assertions reported as failures when none of them had run.
 *
 * That is expensive in the wrong way: a wrong table name is knowable from the migrations without a
 * database, and finding it out from a CI round-trip trains everyone to read a red as "scaffolding
 * again" rather than as a result. So it is knowable here, in a test that needs no Postgres.
 *
 * ## Why this reads the SQL rather than the database
 *
 * The point is to fail *before* CI, on a machine with no Postgres — which is the only place the mistake
 * is cheap. Reading the migrations is the same source of truth the fixture builds from, so agreeing
 * with it is exactly the property wanted.
 *
 * ## What it took to have no exceptions
 *
 * A first pass reported nine unresolved names. Seven were real tables the scan could not see, because
 * `client_strategies` and `reduction_strategies` are brought into existence by `ALTER TABLE … RENAME
 * TO` rather than by `CREATE TABLE`. Following renames left exactly one offender: the invented one. An
 * exception list would have hidden the finding among six false positives, which is the argument for
 * fixing the scan instead of allowing around it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(here, "..", "migrations");

/** How an object comes into existence in a migration. */
const CREATES = [
  // `UNLOGGED` and `TEMP` sit between CREATE and TABLE. Missing them made this guard report a table a
  // migration plainly creates as one no migration creates — the guard firing correctly on its own blind
  // spot rather than on a real fault.
  /CREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:nzi_console\.)?([a-z_][a-z0-9_]*)/gi,
  /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:nzi_console\.)?([a-z_][a-z0-9_]*)/gi,
  /CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:nzi_console\.)?([a-z_][a-z0-9_]*)/gi,
  /CREATE\s+TYPE\s+(?:nzi_console\.)?([a-z_][a-z0-9_]*)/gi,
  // Being renamed into a name is how `client_strategies` and `reduction_strategies` exist. A scan that
  // reads only CREATE TABLE calls seven passing suites broken.
  /ALTER\s+TABLE\s+(?:nzi_console\.)?[a-z_][a-z0-9_]*\s+RENAME\s+TO\s+(?:nzi_console\.)?([a-z_][a-z0-9_]*)/gi,
];

describe("the suites' fixtures name only what the migrations create", () => {
  it("resolves every nzi_console object a suite references", () => {
    const created = new Set<string>();
    const migrations = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
    for (const file of migrations) {
      const sql = readFileSync(join(MIGRATIONS, file), "utf8");
      for (const pattern of CREATES) {
        for (const match of sql.matchAll(pattern)) created.add(match[1]!.toLowerCase());
      }
    }

    // Sanity before judging anything, and the floor that a gate which scanned zero files taught: if the
    // extraction is broken, every reference below looks unresolved and the failure points everywhere
    // except at the cause.
    assert.ok(migrations.length >= 100, `only ${migrations.length} migrations read — the directory is wrong`);
    assert.ok(created.size >= 120, `only ${created.size} objects extracted — the patterns are wrong, not the fixtures`);
    for (const known of ["organisations", "memberships", "clients", "client_contacts", "provision_organisation", "client_strategies"]) {
      assert.ok(created.has(known), `'${known}' was not detected as created, so the extraction cannot be trusted`);
    }

    const unresolved: string[] = [];
    let scanned = 0;
    for (const file of readdirSync(here).filter((name) => name.endsWith(".test.ts"))) {
      const source = readFileSync(resolve(here, file), "utf8");
      scanned += 1;
      const referenced = new Set([...source.matchAll(/nzi_console\.([a-z_][a-z0-9_]*)/g)].map((match) => match[1]!.toLowerCase()));
      for (const name of referenced) {
        if (!created.has(name)) unresolved.push(`${file}: nzi_console.${name}`);
      }
    }
    assert.ok(scanned >= 40, `only ${scanned} suites scanned — the answer would be empty for the wrong reason`);

    assert.deepEqual(unresolved.sort(), [],
      "a suite names something no migration creates. It will fail in CI as 'relation does not exist', and if it is in a before hook every test in the file is cancelled without running.");
  });
});
