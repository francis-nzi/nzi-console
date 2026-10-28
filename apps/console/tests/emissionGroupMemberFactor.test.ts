// A roll-up group is priced with one factor: the Company Vehicles import says so before it sends a vehicle on another factor to a
// chosen group (the write refuses it anyway — proved in isolated-backend's emissionGroupMemberFactorReal). One row per distinct
// factor, composing the category total; ungrouped stays the default.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const importer = readFileSync(resolve(here, "..", "app/jobs/VehicleTemplateImport.tsx"), "utf8");

describe("The vehicle import and a roll-up group's one factor", () => {
  it("holds back a vehicle whose factor is not the chosen group's, and says why", () => {
    assert.match(importer, /&& !offGroup\(line\);/, "a vehicle off the group's factor is still offered as Ready");
    assert.match(importer, /a group is one factor: import it ungrouped, or into a group on its own factor/);
  });
  it("keeps ungrouped — one row each — as the default, and no longer promises one Company Vehicles row", () => {
    assert.match(importer, /<option value="">Ungrouped — one row each<\/option>/);
    assert.match(importer, /const \[groupId, setGroupId\] = useState\(""\);/);
    assert.doesNotMatch(importer, /one Company Vehicles row/);
  });
});
