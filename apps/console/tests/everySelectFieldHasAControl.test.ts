import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { renderInputSpec } from "@nzi/contracts";
import { seededSpec } from "./support/entryRenderMatrix";

/**
 * Every `select` the spec declares is one the form knows how to draw (NZC-159).
 *
 * The form switches on `field.control`, and its `select` case used to read
 * `field.key === "qualityTier" ? … : <data confidence>` — so **any** other select rendered as Data
 * confidence, bound to `draft.dataConfidence`. Adding `supplySource` to the spec would have put a second
 * "Data confidence" control on every electricity entry, silently overwriting the real one. The form would
 * have looked like it worked.
 *
 * That is the catch-all shape this codebase keeps finding: a branch that handles the case it knows and
 * quietly mislabels everything else. The form now names each key and renders nothing for an unknown one,
 * and this is what stops "renders nothing" becoming the new silent failure — a select in the spec with no
 * branch fails here rather than disappearing from the form.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FORM = join(ROOT, "apps/console/app/jobs/EmissionEntryForm.tsx");

describe("the entry form can draw every select the spec declares", () => {
  it("has a branch for each, so none renders as another field", () => {
    const source = readFileSync(FORM, "utf8");
    const selects = new Set<string>();
    for (const category of seededSpec()) {
      for (const audience of ["crm", "portal"] as const) {
        for (const mode of ["new", "existing"] as const) {
          for (const lean of [false, true]) {
            for (const field of renderInputSpec(category, audience, mode, lean)) {
              if (field.control === "select") selects.add(field.key);
            }
          }
        }
      }
    }

    assert.ok(selects.size >= 3, `only ${selects.size} select fields found — the spec did not load`);
    const missing = [...selects].filter((key) => !source.includes(`field.key === "${key}"`));
    assert.deepEqual(missing, [],
      "the spec declares a select the form has no branch for, so it renders nothing — add the control");
  });

  it("does not fall back to another control for an unrecognised select", () => {
    // The specific regression: a trailing `: (…)` on the select branch would make an unknown key render
    // as whatever that branch draws. Asserted on the source because it is a property of the code's
    // shape rather than of any one render.
    const source = readFileSync(FORM, "utf8");
    const selectCase = source.slice(source.indexOf('case "select":'), source.indexOf('case "textarea":'));
    assert.ok(selectCase.includes("return null;"),
      "the select branch has no explicit fallthrough — an unknown key may be rendering as another field");
    assert.ok(!/\)\s*:\s*\(/.test(selectCase),
      "the select branch still uses a ternary chain, so an unknown key renders as its else arm");
  });
});
