import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emissionCategoryTaxonomy } from "@nzi/contracts";
import { buildEmissionEntryFields, entryUnitsForCategory, manualEntryHint } from "../app/jobs/emissionEntryModel";
import { COMPANY_VEHICLE, ELECTRICITY, renderMatrix } from "./support/entryRenderMatrix";

/**
 * What the entry model renders today, written down before it moves (NZC-102).
 *
 * The per-category input model is 488 lines of TypeScript that both surfaces already read — the
 * consultant's data-entry accordion and the client portal's category entry. It is becoming governed
 * reference data: versioned rows, provenanced, audited, deactivate-not-delete. A migration of
 * something two surfaces depend on is only safe if "changed nothing" can be checked, so this pins
 * the whole matrix first: every category, both audiences, both modes, lean capture on and off.
 *
 * **The golden file records what the product does, not what is right.** If a render in it is wrong,
 * it is wrong in the running product too, and correcting it is a separate decision with its own
 * reasoning — not something to slip inside a migration. That distinction is the point of pinning
 * first rather than writing the spec and hoping the diff looks plausible.
 *
 * The two exemplars are additionally spelled out inline below. A golden file proves equality and
 * shows nothing; a reader reviewing the spec migration needs to see what electricity and company
 * vehicle actually produce without opening a 300KB fixture.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GOLDEN = join(ROOT, "apps/console/tests/fixtures/entryRenderMatrix.golden.json");

describe("the entry render matrix is pinned before the spec migration", () => {
  it("matches the committed golden for every category, audience, mode and capture style", () => {
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, unknown>;
    const current = renderMatrix();
    // Compared as one structure rather than key by key: a render that disappears is as much a
    // change as one that differs, and a per-key loop over the current matrix would not notice.
    assert.deepEqual(
      JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b))))),
      golden,
      "the entry model renders differently from the pinned matrix — if that is intended, regenerate the golden in its own commit and say why");
  });

  it("covers every category in the taxonomy, so the pin has no blind spot", () => {
    const current = renderMatrix();
    for (const category of emissionCategoryTaxonomy) {
      const keys = Object.keys(current).filter((key) => key.startsWith(`${category.code}|`));
      assert.equal(keys.length, 8, `${category.code} must be pinned across both audiences, both modes, lean and full`);
    }
    assert.equal(Object.keys(current).length, emissionCategoryTaxonomy.length * 8);
  });
});

describe("electricity — the exemplar, spelled out", () => {
  const fields = (audience: "crm" | "portal", mode: "new" | "existing", lean = false) =>
    buildEmissionEntryFields(ELECTRICITY, audience, mode, lean).map((field) => field.key);

  it("is a manual-kind category: no registration finder, no spend group", () => {
    assert.equal(ELECTRICITY.kind, "manual");
    assert.ok(!fields("crm", "new").includes("registrationFinder"));
    assert.ok(!fields("crm", "new").includes("spendDetails"));
  });

  it("gives the consultant the factor, quality tier and confidence", () => {
    assert.deepEqual(fields("crm", "new"),
      ["siteBanner", "activity", "quantity", "unit", "monthly", "factor", "qualityTier", "dataConfidence", "note", "documents"]);
  });

  it("gives the client none of the factor internals", () => {
    // The portal parity rule: the same renderer, a narrower field set. A client never sees or sets
    // the factor, the quality tier or the data confidence.
    const portal = fields("portal", "new");
    for (const withheld of ["factor", "qualityTier", "dataConfidence", "lineage"]) {
      assert.ok(!portal.includes(withheld), `the portal must not render ${withheld}`);
    }
    assert.deepEqual(portal, ["siteBanner", "activity", "quantity", "unit", "monthly", "note", "documents"]);
  });

  it("labels quantity and unit plainly, not as spend", () => {
    const rendered = buildEmissionEntryFields(ELECTRICITY, "crm", "new");
    assert.equal(rendered.find((field) => field.key === "quantity")!.label, "Quantity");
    assert.equal(rendered.find((field) => field.key === "unit")!.label, "Unit");
  });

  it("offers kWh first among its units", () => {
    assert.equal(entryUnitsForCategory(ELECTRICITY)[0], "kWh");
  });

  it("shows lineage only to a consultant looking at an existing row", () => {
    assert.ok(fields("crm", "existing").includes("lineage"));
    assert.ok(!fields("crm", "new").includes("lineage"));
    assert.ok(!fields("portal", "existing").includes("lineage"));
  });

  it("under lean capture drops quality, confidence, notes and documents, and reviews the factor", () => {
    const lean = buildEmissionEntryFields(ELECTRICITY, "crm", "new", true);
    assert.deepEqual(lean.map((field) => field.key), ["siteBanner", "activity", "quantity", "unit", "monthly", "factor"]);
    assert.equal(lean.find((field) => field.key === "factor")!.control, "factor-review");
  });

  it("ignores lean capture for the portal and for an existing row", () => {
    // `lean` is derived from three inputs, not a field-level flag — it only applies to a new
    // consultant entry. This is the rule most likely to be lost in a translation to data.
    assert.deepEqual(fields("portal", "new", true), fields("portal", "new", false));
    assert.deepEqual(fields("crm", "existing", true), fields("crm", "existing", false));
  });
});

describe("company vehicle — the exemplar, spelled out", () => {
  const rendered = (audience: "crm" | "portal", mode: "new" | "existing" = "new", lean = false) =>
    buildEmissionEntryFields(COMPANY_VEHICLE, audience, mode, lean);

  it("is a registration-kind category, so it opens with the vehicle finder", () => {
    assert.equal(COMPANY_VEHICLE.kind, "vehicle");
    assert.equal(rendered("crm")[1]!.key, "registrationFinder");
    assert.equal(rendered("crm")[1]!.control, "registration");
  });

  it("offers the registration finder to the client too", () => {
    // The client enters vehicles by registration exactly as the consultant does — the finder is not
    // a consultant-only affordance.
    assert.ok(rendered("portal").some((field) => field.key === "registrationFinder"));
  });

  it("labels the finder Vehicle, and names the manual fallback", () => {
    const finder = rendered("crm").find((field) => field.key === "registrationFinder")!;
    assert.equal(finder.label, "Vehicle");
    assert.equal(finder.hint, "DVLA registration lookup, or enter make · model · fuel manually.");
    assert.equal(manualEntryHint(COMPANY_VEHICLE), "make · model · fuel");
  });

  it("is not a passenger-distance category, unlike travel and commuting", () => {
    // A vehicle's own distance, not a passenger's. The unit list differs from the two other
    // registration kinds, which is exactly the kind of per-kind detail a spec must carry.
    assert.ok(!entryUnitsForCategory(COMPANY_VEHICLE).includes("passenger.km"));
    const commuting = emissionCategoryTaxonomy.find((category) => category.kind === "commuting")!;
    assert.equal(entryUnitsForCategory(commuting)[0], "passenger.km");
  });

  it("labels the finder differently for commuting, where a mode is not a vehicle", () => {
    const commuting = emissionCategoryTaxonomy.find((category) => category.kind === "commuting")!;
    assert.equal(buildEmissionEntryFields(commuting, "crm", "new")[1]!.label, "Vehicle / mode");
  });

  it("interpolates the category into the activity hint", () => {
    // A template, not a constant: the spec must store the placeholder and let the interpreter
    // substitute, or every category needs its own literal string.
    const activity = rendered("crm").find((field) => field.key === "activity")!;
    assert.equal(activity.hint, "Smart search — Scope 1 · Company Vehicles factors only.");
  });
});

describe("spend categories relabel rather than add fields", () => {
  const spend = emissionCategoryTaxonomy.find((category) => category.code === "3.1")!;

  it("turns quantity and unit into net value and VAT", () => {
    const rendered = buildEmissionEntryFields(spend, "crm", "new");
    assert.equal(rendered.find((field) => field.key === "quantity")!.label, "Net value (£)");
    const unit = rendered.find((field) => field.key === "unit")!;
    assert.equal(unit.label, "VAT %");
    assert.equal(unit.control, "number", "a VAT percentage is a number, not a unit picker");
    assert.equal(unit.optional, true);
  });

  it("adds the spend group, and words its hint differently per audience", () => {
    const crm = buildEmissionEntryFields(spend, "crm", "new").find((field) => field.key === "spendDetails")!;
    const portal = buildEmissionEntryFields(spend, "portal", "new").find((field) => field.key === "spendDetails")!;
    assert.notEqual(crm.hint, portal.hint, "the consultant is told about the Scope 3.1 sync; the client is not");
    assert.ok(crm.hint!.includes("Consultant maps factors"));
    assert.ok(portal.hint!.includes("your authorised purchased-goods category"));
  });

  it("puts GBP first in its unit list", () => {
    assert.equal(entryUnitsForCategory(spend)[0], "GBP");
  });
});
