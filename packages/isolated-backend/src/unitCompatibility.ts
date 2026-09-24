import type { UnitReconciler } from "@nzi/contracts";
import { denominatorOf, MILES_PER_KM } from "./lcaUnits";

/**
 * Whether an entered unit can stand for a factor's activity unit, and what it becomes if so (NZC-146).
 *
 * ## Why this is beside `lcaUnits` rather than inside it
 *
 * The brief said to convert "via `lcaUnits`". `lcaUnits` cannot: it is not a unit library. It is a parity
 * mirror of the live engine's `lca_engine.py` / `lca_transport.py` — GHG numerator multipliers, the
 * tonne-vs-kg material basis, freight denominators, haversine distance, detour factors — and its own
 * header says a line's quantity is *always* kg by live policy. It has no `convert(value, from, to)`, no
 * notion of compatibility, and nothing at all for kWh, GJ, litres, passenger-km, m², nights or GBP. Its
 * comment is explicit that non-mass activity units "are left at 1.0 — no density is available".
 *
 * Adding general conversion to that file would make the question it exists to answer — *does this still
 * match the live engine?* — unanswerable. So the conversions live here, and the one number that is a
 * **choice** rather than a definition is imported from `lcaUnits` rather than retyped: `MILES_PER_KM`.
 * Tonnes-to-kilograms and litres-to-cubic-metres are definitions, not policy; `lcaUnits` encodes the same
 * mass relationship in `materialBasisMultiplier`, and stating it twice is not two sources of truth in the
 * way a rounded constant would be.
 *
 * ## Compatible, convertible, or rejected — never silently passed
 *
 * Same unit: accepted. Same dimension: converted, with the factor applied to the quantity. Different
 * dimension: **rejected**. There is no "assume they meant the same thing", because the failure that
 * produces is a number that is wrong by three orders of magnitude and looks entirely ordinary — litres of
 * diesel against a per-kilometre factor is a plausible-looking answer and a fiction.
 *
 * Money, counts and area are identity-only on purpose. £1 is not convertible to anything, and a unit that
 * has no conversion should say so rather than fall through to a default of 1.
 */

/** What a unit measures. Conversion happens within one of these and never across. */
export type UnitDimension =
  | "energy" | "volume" | "mass" | "distance" | "passenger-distance"
  | "freight" | "area" | "count" | "money";

type UnitDefinition = { dimension: UnitDimension; /** How many canonical units one of these is. */ inCanonical: number };

/**
 * The units this system actually writes, with the canonical member of each dimension first.
 *
 * Spellings are the ones already stored — `mi`, `passenger.km`, `m²` — rather than tidier ones, because
 * the stored value is what a check has to recognise. Aliases are listed where a factor's `activity_unit`
 * says the same thing differently; a factor library is not ours to spell.
 */
const UNITS: Record<string, UnitDefinition> = {
  // Energy — canonical kWh.
  "kwh": { dimension: "energy", inCanonical: 1 },
  "mwh": { dimension: "energy", inCanonical: 1_000 },
  "gwh": { dimension: "energy", inCanonical: 1_000_000 },
  // 1 GJ = 277.777… kWh. Named in the brief's workflows and arithmetic rather than policy.
  "gj": { dimension: "energy", inCanonical: 1_000 / 3.6 },
  "mj": { dimension: "energy", inCanonical: 1 / 3.6 },

  // Volume — canonical litres.
  "litres": { dimension: "volume", inCanonical: 1 },
  "litre": { dimension: "volume", inCanonical: 1 },
  "l": { dimension: "volume", inCanonical: 1 },
  "m3": { dimension: "volume", inCanonical: 1_000 },
  "m³": { dimension: "volume", inCanonical: 1_000 },

  // Mass — canonical kg.
  "kg": { dimension: "mass", inCanonical: 1 },
  "tonnes": { dimension: "mass", inCanonical: 1_000 },
  "tonne": { dimension: "mass", inCanonical: 1_000 },
  "t": { dimension: "mass", inCanonical: 1_000 },

  // Distance — canonical km. The mile is `lcaUnits`' constant, not a second rounding of it.
  "km": { dimension: "distance", inCanonical: 1 },
  "mi": { dimension: "distance", inCanonical: 1 / MILES_PER_KM },
  "miles": { dimension: "distance", inCanonical: 1 / MILES_PER_KM },

  // Passenger-distance — a separate dimension from distance. A passenger-kilometre is not a kilometre,
  // and a factor priced per passenger-km applied to vehicle-km overstates a full car by its occupancy.
  "passenger.km": { dimension: "passenger-distance", inCanonical: 1 },
  "passenger.mi": { dimension: "passenger-distance", inCanonical: 1 / MILES_PER_KM },

  // Freight — canonical tonne-km.
  "tonne.km": { dimension: "freight", inCanonical: 1 },
  "t.km": { dimension: "freight", inCanonical: 1 },
  // The middle-dot spelling is the one the seeded factors actually store.
  "t·km": { dimension: "freight", inCanonical: 1 },
  "tonne·km": { dimension: "freight", inCanonical: 1 },
  "tonne.mi": { dimension: "freight", inCanonical: 1 / MILES_PER_KM },
  "t·mi": { dimension: "freight", inCanonical: 1 / MILES_PER_KM },

  // Identity-only dimensions: real units with no conversion, said so rather than defaulted.
  "m2": { dimension: "area", inCanonical: 1 },
  "m²": { dimension: "area", inCanonical: 1 },
  "units": { dimension: "count", inCanonical: 1 },
  "nights": { dimension: "count", inCanonical: 1 },
  "gbp": { dimension: "money", inCanonical: 1 },
};

/**
 * The stored spelling reduced to a lookup key.
 *
 * Deliberately narrow: case and surrounding space only. It does **not** strip punctuation or guess, so
 * `tCO2e/tonne.km` does not quietly become `tonne.km`; a factor unit that needs taking apart is taken
 * apart by the caller, which knows whether it is looking at a numerator or a denominator.
 */
const key = (unit: string): string => unit.trim().toLowerCase();

export const unitDimension = (unit: string | null | undefined): UnitDimension | null =>
  unit == null ? null : UNITS[key(unit)]?.dimension ?? null;

export const isKnownUnit = (unit: string | null | undefined): boolean => unitDimension(unit) !== null;

export type UnitCheck =
  /** The same unit, or the same spelling of it. Nothing to do. */
  | { kind: "same"; unit: string }
  /** Convertible: `factor` multiplies the entered quantity to reach the factor's unit. */
  | { kind: "convert"; from: string; to: string; factor: number; dimension: UnitDimension }
  /** Not convertible, with a reason a person can act on. */
  | { kind: "reject"; reason: string };

/**
 * Check an entered unit against the unit a factor is priced in.
 *
 * An unknown unit on either side is a rejection rather than a pass. The alternative — treating anything
 * unrecognised as compatible — is the shape of check whose failure is indistinguishable from its success,
 * and the thing it would let through is a quantity multiplied by the wrong factor.
 */
export function checkUnit(entered: string | null | undefined, factorUnit: string | null | undefined): UnitCheck {
  const enteredKey = entered == null ? "" : key(entered);
  // A factor unit may be compound — "kgCO2e/km" — and it is the *denominator* the entered quantity has
  // to match: the numerator says what the factor produces, not what it is priced per. Taken apart by
  // lcaUnits' own parser so there is one answer to where the slash falls.
  const factorKey = factorUnit == null ? "" : key(denominatorOf(factorUnit));

  if (enteredKey === "" || factorKey === "") {
    return { kind: "reject", reason: "a unit is missing: the entry has no unit, or the factor is not priced in one" };
  }
  if (enteredKey === factorKey) return { kind: "same", unit: entered!.trim() };

  const from = UNITS[enteredKey];
  const to = UNITS[factorKey];
  if (!from) {
    return { kind: "reject", reason: `'${entered}' is not a unit this system knows, so it cannot be checked against '${factorUnit}'` };
  }
  if (!to) {
    return { kind: "reject", reason: `the factor is priced in '${factorUnit}', which is not a unit this system knows` };
  }
  if (from.dimension !== to.dimension) {
    return {
      kind: "reject",
      reason: `'${entered}' measures ${from.dimension} and the factor is priced per ${to.dimension} — `
        + `these are different quantities, and multiplying one by the other would produce a number that looks ordinary and is not`,
    };
  }
  if (from.dimension === "money" || from.dimension === "count" || from.dimension === "area") {
    // Same dimension, different spelling, no ratio between them: m² and m2 are caught by the same-key
    // test above, so reaching here means two genuinely different units of an unconvertible kind.
    return { kind: "reject", reason: `'${entered}' and '${factorUnit}' are both ${from.dimension} but there is no conversion between them` };
  }

  return {
    kind: "convert",
    from: entered!.trim(),
    to: factorUnit!.trim(),
    factor: from.inCanonical / to.inCanonical,
    dimension: from.dimension,
  };
}

/** The quantity as the factor's unit would have it, or null when the units do not reconcile. */
export function quantityInFactorUnit(
  quantity: number, entered: string | null | undefined, factorUnit: string | null | undefined,
): { quantity: number; check: UnitCheck } | null {
  const check = checkUnit(entered, factorUnit);
  if (check.kind === "reject") return null;
  return { quantity: check.kind === "same" ? quantity : quantity * check.factor, check };
}

/**
 * `checkUnit` in the shape the declarative resolver takes (NZC-160 D2).
 *
 * The resolver is pure and lives in contracts, so it is handed this rather than a copy of the unit table: one
 * definition of which units reconcile, asked at resolution and again at the write. Convertible counts as
 * reconciling — the write converts it — and only a rejection declines the rule.
 */
export const reconcileUnitForMapping: UnitReconciler = (entered, factorUnit) => {
  const check = checkUnit(entered, factorUnit);
  return check.kind === "reject" ? { ok: false, reason: check.reason } : { ok: true };
};

/**
 * Whether a unit is one the spec offers for a field.
 *
 * Separate from the factor check, and asked first: "this category does not collect litres" and "this
 * factor is not priced in litres" are different problems with different fixes, and one message covering
 * both would send somebody to the wrong one.
 */
export function isAcceptedUnit(entered: string | null | undefined, accepted: readonly string[]): boolean {
  if (accepted.length === 0) return true; // Nothing declared: the field does not constrain units.
  const enteredKey = entered == null ? "" : key(entered);
  return accepted.some((unit) => key(unit) === enteredKey);
}
