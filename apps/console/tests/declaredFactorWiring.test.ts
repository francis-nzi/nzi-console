import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * The capture form uses the shared declared-factor functions, and the workspace hands it the preview (Stop 2b).
 *
 * What those functions do is proved end to end in declaredFactorFormReal, through the real write and a calculated
 * number. This holds the wiring: that the form seeds and checks divergence with *those* functions rather than a
 * second copy, only for a new entry, and that the workspace maps the preview onto the options it offers.
 */

const APP = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "app/jobs");
const read = (file: string) => readFileSync(join(APP, file), "utf8");

describe("the declared factor reaches the capture form through the shared functions", () => {
  it("seeds and checks divergence with the model's functions, for a new entry only", () => {
    const formSource = read("EmissionEntryForm.tsx");
    assert.ok(formSource.includes("seedWithDeclared("), "the form does not seed through seedWithDeclared");
    assert.ok(formSource.includes("needsOverrideReason("), "the form does not check divergence through needsOverrideReason");
    assert.ok(/const declared = mode === "new" \? props\.declared \?\? null : null;/.test(formSource),
      "the preview applies to more than a new entry — an existing row's factor would be re-seeded");
  });

  it("maps the preview onto the options the workspace offers, and passes it to the quick-add form", () => {
    const workspace = read("CrpScopeWorkspace.tsx");
    assert.ok(workspace.includes("declaredOptionFor("), "the workspace does not map the preview through declaredOptionFor");
    assert.ok(workspace.includes("declared={declaredOption}"), "the quick-add form is not given the declared factor");
    assert.ok(workspace.includes("/declared-factor"), "the workspace does not ask the declared-factor route");
  });
});
