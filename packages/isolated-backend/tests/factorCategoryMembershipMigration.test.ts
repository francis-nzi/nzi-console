import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/** The shape of migration 0209 (NZC-171), pinned without a database: the guards that make the membership map reviewable and permanent. */
const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(resolve(here, "../migrations/0209_factor_category_membership.sql"), "utf8").replace(/\r\n/g, "\n");

describe("0209 factor_category_membership", () => {
  it("is a global table the app reads and Admin edits through commands, never deleted or re-pointed, one rule per family and category", () => {
    for (const clause of [
      "CREATE TABLE nzi_console.factor_category_membership", "factor_category_membership_l3_needs_l2", "factor_category_membership_retired_shape",
      "CREATE UNIQUE INDEX factor_category_membership_one_rule", "A membership rule is never deleted", "A membership rule is never re-pointed",
      "BEFORE UPDATE OR DELETE ON nzi_console.factor_category_membership", "GRANT SELECT, INSERT, UPDATE ON nzi_console.factor_category_membership TO nzi_console_app",
      "REVOKE DELETE ON nzi_console.factor_category_membership FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth",
    ]) assert.ok(sql.includes(clause), clause);
    assert.ok(!/ENABLE ROW LEVEL SECURITY/i.test(sql), "global reference data, as the category registry is");
  });

  it("seeds the ruled map, audited per organisation, and holds Heat and steam back rather than filing it under purchased electricity", () => {
    assert.ok(sql.includes("'migration:0209'") && sql.includes("'factor.membership.seeded'"));
    assert.match(sql, /\('Heat and steam', NULL, NULL, NULL,/);
    assert.ok(!/\('Heat and steam'[^\n]*'2\.purchased-electricity'/.test(sql), "ruling 7: not mis-filed under purchased electricity");
    assert.ok(!/\('UK electricity for EVs'[^\n]*'1\.company-vehicles'/.test(sql), "ruling 5's fallback: EV charging is not filed under company vehicles");
    assert.ok(!/\('UK Renewable Electricity'[^\n]*'2\.purchased-electricity'/.test(sql), "ruling 6: renewable electricity is its own category only");
    assert.ok(sql.includes("'Natural gas (100% mineral blend)', '1.natural-gas'"), "ruling 1: every natural-gas level 3 is natural gas");
  });
});
