import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { clientCertifications, clientGroupStructures, clientReportingFrameworks, clientReportingFrequencies, scope3CategoryCodes } from "@nzi/contracts";

const here = dirname(fileURLToPath(import.meta.url));
const seed = readFileSync(resolve(here, "../seeds/0011_synthetic_client_profiles.sql"), "utf8");
const migration = readFileSync(resolve(here, "../migrations/0060_client_identity_parity.sql"), "utf8");

/** Every ARRAY[...] literal in the seed, by the column it is assigned to in the VALUES rows. */
function arrayLiterals(): string[][] {
  return [...seed.matchAll(/ARRAY\[([^\]]*)\]::text\[\]/g)].map(([, body]) =>
    (body ?? "").split(",").map((entry) => entry.trim().replace(/^'|'$/g, "")).filter(Boolean),
  );
}

describe("synthetic client profile seed (NZC-064)", () => {
  it("only uses vocabulary the edit form would accept back", () => {
    // A seeded value outside the contract's vocabulary loads fine but fails validation
    // the moment a consultant saves the tab — the seed would be rejecting itself.
    const allowed = new Set<string>([...clientReportingFrameworks, ...clientCertifications, ...scope3CategoryCodes]);
    const used = new Set(arrayLiterals().flat());
    assert.ok(used.size > 0, "expected the seed to populate compliance arrays");
    const unknown = [...used].filter((entry) => !allowed.has(entry));
    assert.deepEqual(unknown, [], `seeded values outside the contract vocabulary: ${unknown.join(", ")}`);
  });

  it("uses canonical Scope 3 taxonomy codes, never the 'Cat N' display labels", () => {
    const scope3 = [...arrayLiterals().flat()].filter((entry) => /^3\./.test(entry) || /^Cat /i.test(entry));
    assert.ok(scope3.length > 0);
    for (const code of scope3) assert.ok(scope3CategoryCodes.includes(code), `${code} is not a taxonomy code`);
  });

  it("keeps reporting frequency, currency and group structure inside their constraints", () => {
    for (const [, value] of seed.matchAll(/'(annual|quarterly|monthly|fortnightly|weekly)'/g)) {
      assert.ok((clientReportingFrequencies as readonly string[]).includes(value ?? ""), `${value} is not a reporting frequency`);
    }
    for (const [, value] of seed.matchAll(/'(standalone|subsidiary|parent|joint-venture|conglomerate)'/g)) {
      assert.ok((clientGroupStructures as readonly string[]).includes(value ?? ""), `${value} is not a group structure`);
    }
    for (const [, value] of seed.matchAll(/, '([A-Z]{3})',/g)) assert.match(value ?? "", /^[A-Z]{3}$/);
  });

  it("pairs every net-zero target year with its reduction, as the command requires", () => {
    // client.update rejects a year without a percentage; a seeded row that breaks the
    // pairing cannot be saved from the Targets tab without the consultant fixing it first.
    const rows = seed.split(/\n\s*\(\n/).slice(1);
    for (const row of rows) {
      const targets = row.match(/\n\s{4}(NULL|\d{4})(?:::int)?, (NULL|[\d.]+)(?:::numeric)?, (?:DATE '[\d-]{10}'|NULL)/);
      if (!targets) continue;
      const [, year, reduction] = targets;
      assert.equal(year === "NULL", reduction === "NULL", `net-zero year/reduction must be set together, saw ${year}/${reduction}`);
    }
  });

  it("stays synthetic — no live domains, and every seeded contact is .invalid", () => {
    assert.ok(!/nzi-insights-pro-web-live|netzero\.international|onrender\.com/i.test(seed));
    for (const [, host] of seed.matchAll(/https?:\/\/([^\s'"/]+)/g)) assert.match(host ?? "", /\.invalid$/);
  });

  it("seeds only columns the migration actually adds", () => {
    const added = new Set([...migration.matchAll(/ADD COLUMN (\w+)/g)].map(([, column]) => column));
    const setClause = seed.slice(seed.indexOf("UPDATE clients c SET"), seed.indexOf("FROM profile p"));
    const assigned = [...setClause.matchAll(/(\w+) = p\.(\w+)/g)].filter(([, target, source]) => target === source).map(([, column]) => column);
    assert.ok(assigned.length >= 40, `expected the seed to assign the profile columns, saw ${assigned.length}`);
    const strays = assigned.filter((column) => !added.has(column));
    assert.deepEqual(strays, [], `seed assigns columns migration 0060 does not add: ${strays.join(", ")}`);
  });
});
