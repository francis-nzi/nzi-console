/**
 * v7's report-time emissions arithmetic, ported line for line (decision 9, ruled: a migrated row's figure is the one
 * v7 reported). Sources, in v7's code:
 *
 *   - `services/monthly_emissions.py` — `_calc_tco2e`, `_effective_ghg_unit`, `JobMonthlyEmissionsResolver.row_metrics`
 *     and `_resolve_standard_factor_for_month`: a scope row's figure;
 *   - `services/emissions_reporting.py` — `combined_row_metrics`: a register source's figure;
 *   - `api/job_data_output_routes.py` — `_load_data_output_rows` (which rows count) and `_build_scope_summary` (how
 *     they are rounded and totalled into the `scope_totals` a report snapshot freezes).
 *
 * Faithful includes v7's quirks, which are what its clients were shown:
 *   - `apply_pct` of 0 or NULL reads as 100 (`_safe_float(...) or 100.0`);
 *   - a unit is per-kg when "kg" appears anywhere in it, and a missing unit reads as "kgCO2e";
 *   - **`override_tco2e` is never read** — neither reporting query selects it — so it does not enter the figure;
 *   - `source_qty`/`source_uom` are selected as NULL by both reporting queries, so a source volume never counts;
 *   - a register source's stored `calc_tco2e` is used when present, and recomputed only when NULL;
 *   - rounding is Python's `round(x, 2)`: correctly rounded, ties to even.
 *
 * Where v7 would consult its live factor tables (a month priced from another dataset, a custom factor's year value, a
 * unit or fallback decision that turns on a lookup the extract did not carry), the figure uses the row's own copied
 * factor — v7's own same-dataset path — and the row is **flagged**, never silently treated as exact. The job's
 * published snapshot is what stands for it (decision 2), and the per-job reconciliation shows any difference.
 */

export type NotReplayable =
  | "monthly-dataset-map-absent"
  | "monthly-factor-relookup"
  | "custom-factor-monthly"
  | "unit-needs-lookup"
  | "fallback-needs-lookup";

/** `_safe_float`: NULL, blank, unparseable and non-finite are None. */
export function pyFloat(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = value.trim();
  if (text === "") return null;
  const lowered = text.toLowerCase();
  const parsed = lowered === "inf" || lowered === "infinity" ? Infinity : lowered === "-inf" || lowered === "-infinity" ? -Infinity : Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Python's `x or default` for a float: 0 and None both fall through. */
const orDefault = (value: number | null, fallback: number): number => (value ? value : fallback);

/** Python's `round(x, 2)`: the double's exact value, rounded to nearest, exact ties to even. */
export function pyRound2(value: number): number {
  if (!Number.isFinite(value)) return value;
  const expansion = Math.abs(value).toFixed(100);
  const [whole, fraction] = expansion.split(".") as [string, string];
  const exactTie = fraction[2] === "5" && /^0*$/.test(fraction.slice(3));
  if (!exactTie) return Number(value.toFixed(2)) || 0;
  const hundredths = Number(whole + fraction.slice(0, 2));
  const even = hundredths % 2 === 0 ? hundredths : hundredths + 1;
  const magnitude = even / 100;
  return value < 0 ? -magnitude : magnitude;
}

const isKgUnit = (unit: string | null): boolean => (unit ?? "").replace(/ /g, "").toLowerCase().includes("kg");

/** `_calc_tco2e`. */
export function calcTco2e(qty: number | null, factor: number | null, ghgUnit: string | null, applyPct: number | null): number {
  const qtyValue = qty ?? 0;
  const factorValue = factor ?? 0;
  const pct = orDefault(applyPct, 100);
  let emissions = qtyValue * factorValue * (pct / 100);
  if ((ghgUnit || "kgCO2e").toLowerCase().includes("kg")) emissions = emissions / 1000;
  return emissions;
}

/** `_effective_ghg_unit`. `reference` undefined means the lookup's answer is not known (not in the extract). */
function effectiveGhgUnit(storageUom: string | null, storageUnit: string | null, reference: string | null | undefined):
  { unit: string | null; needsLookup: boolean } {
  const stored = storageUnit?.trim() || null;
  const referenceUnit = reference === undefined ? undefined : reference?.trim() || null;
  const uom = (storageUom ?? "").trim().toLowerCase();
  if (!stored) return referenceUnit === undefined ? { unit: null, needsLookup: true } : { unit: referenceUnit, needsLookup: false };
  if (isKgUnit(stored)) return { unit: stored, needsLookup: false };
  if (uom === "tco2e") return { unit: stored, needsLookup: false };
  if (referenceUnit === undefined) return { unit: stored, needsLookup: true };
  if (isKgUnit(referenceUnit)) return { unit: referenceUnit, needsLookup: false };
  return { unit: stored || referenceUnit, needsLookup: false };
}

const FACTOR_ORIGINAL_ID = /(?:^|[;( ])factor_original_id=([^;)\s]+)/i;
const STORAGE_REASON = /(?:^|[;( ])storage_reason=([^;)\s]+)/i;
const noteToken = (notes: Cell, pattern: RegExp): string | null => {
  const match = pattern.exec(notes ?? "");
  return match ? (match[1] ?? "").trim() || null : null;
};

/** An extracted cell: text, NULL, or absent from the file. */
type Cell = string | null | undefined;

export type ScopeRowInput = {
  scope: Cell;
  qty: Cell; uom: Cell; factor: Cell; ghgUnit: Cell; applyPct: Cell;
  months: ReadonlyArray<Cell>;
  datasetId: Cell; factorDbId: Cell; originalId: Cell;
  /** Read only for v7's two tokens (`factor_original_id=`, `storage_reason=`); never carried anywhere. */
  notes: Cell;
  /** The lookup v7 makes at report time, from the extract. `undefined` = the extract did not carry it. */
  referenceFactor: string | null | undefined;
  referenceGhgUnit: string | null | undefined;
};

export type RowFigure = { tco2e: number; notReplayable: NotReplayable[]; displayQty: number };

/**
 * A scope row's figure, as `row_metrics` computes it. `monthDatasets` is the job's calendar month → scope → dataset map
 * (v7's `month_scope_dataset_map`); `undefined` when the extract did not carry it.
 */
export function scopeRowFigure(row: ScopeRowInput, monthDatasets?: ReadonlyMap<number, ReadonlyMap<string, string | null>>): RowFigure {
  const flags = new Set<NotReplayable>();
  const scope = (row.scope ?? "").trim();
  const applyPct = orDefault(pyFloat(row.applyPct), 100);
  const storageQty = pyFloat(row.qty);
  const storageUom = row.uom == null ? null : row.uom.trim();
  const storageFactor = pyFloat(row.factor);
  const storageGhgUnit = row.ghgUnit == null ? null : row.ghgUnit.trim();
  const factorReference = noteToken(row.notes, FACTOR_ORIGINAL_ID);
  const storageReason = noteToken(row.notes, STORAGE_REASON);
  const referenceKnown = row.referenceFactor !== undefined && row.referenceGhgUnit !== undefined;
  const referenceFactor = referenceKnown ? pyFloat(row.referenceFactor as string | null) : undefined;
  const referenceUnit = referenceKnown ? row.referenceGhgUnit : undefined;

  const resolvedUnit = effectiveGhgUnit(storageUom, storageGhgUnit, referenceUnit);
  // Flagged only where the effective unit is actually used: the same-dataset monthly path uses the raw stored unit.
  const effective = {
    get unit() { if (resolvedUnit.needsLookup) flags.add("unit-needs-lookup"); return resolvedUnit.unit; },
  };

  const monthValues = row.months.map((value) => pyFloat(value));
  const monthlyTotal = monthValues.reduce<number>((total, value) => total + (value ?? 0), 0);
  const monthsPresent = row.months.some((value) => value != null);

  const fallbackStorage = storageUom !== null && storageUom.toLowerCase() === "tco2e"
    && storageFactor !== null && Math.abs(storageFactor - 1) < 1e-9;
  const fallbackWithoutLookup = factorReference !== null || storageReason !== null;

  const annual = (): number => calcTco2e(storageQty ?? monthlyTotal, storageFactor, effective.unit, applyPct);

  const monthly = (): number => {
    const isCustomFactor = pyFloat(row.factorDbId) === null && pyFloat(row.datasetId) === null && Boolean((row.originalId ?? "").trim());
    const rowDataset = pyFloat(row.datasetId);
    const rowFactorDbId = pyFloat(row.factorDbId);
    let emissions = 0;
    for (let index = 1; index <= 12; index += 1) {
      const monthQty = monthValues[index - 1] ?? 0;
      let factor: number | null = storageFactor;
      let unit: string | null = null;
      if (isCustomFactor) {
        // `_resolve_custom_factor_for_month` prices from the client's custom year values: not in this extract.
        flags.add("custom-factor-monthly");
      } else {
        let monthDataset: number | null;
        if (monthDatasets === undefined) {
          flags.add("monthly-dataset-map-absent");
          monthDataset = rowDataset;
        } else {
          const mapped = monthDatasets.get(index)?.get(scope);
          monthDataset = mapped === undefined || mapped === null ? rowDataset : pyFloat(mapped);
        }
        if (monthDataset !== null && rowFactorDbId !== null && monthDataset === rowDataset) {
          // v7's same-dataset branch: the row's own copied factor and its raw stored unit.
          factor = storageFactor;
          unit = row.ghgUnit == null ? null : row.ghgUnit.trim();
        } else if (monthDataset === null && rowFactorDbId === null) {
          // No lookup possible: v7 falls through to the row's own factor.
          factor = storageFactor;
          unit = row.ghgUnit == null ? null : row.ghgUnit.trim();
        } else {
          flags.add("monthly-factor-relookup");
          factor = storageFactor;
          unit = row.ghgUnit == null ? null : row.ghgUnit.trim();
        }
      }
      const monthFactor = orDefault(factor, orDefault(storageFactor, 0));
      const monthUnit = unit || effective.unit;
      emissions += calcTco2e(monthQty, monthFactor, monthUnit, applyPct);
    }
    return emissions;
  };

  let tco2e: number;
  let displayQty: number;
  if (fallbackStorage && fallbackWithoutLookup) {
    tco2e = annual(); displayQty = storageQty ?? monthlyTotal;
  } else if (fallbackStorage && referenceFactor === undefined) {
    // Whether v7 took its emissions-fallback path turns on a lookup the extract did not carry. Where both paths
    // agree it does not matter; where they differ, the row is flagged and the annual path (the fallback) is used.
    const asFallback = annual();
    const before = new Set(flags);
    const asOrdinary = monthsPresent ? monthly() : annual();
    // The path not taken leaves no flags of its own behind; only the ambiguity itself is recorded.
    flags.clear(); for (const flag of before) flags.add(flag);
    if (Math.abs(asFallback - asOrdinary) > 1e-12) flags.add("fallback-needs-lookup");
    tco2e = asFallback; displayQty = storageQty ?? monthlyTotal;
  } else if (fallbackStorage && referenceFactor !== null) {
    tco2e = annual(); displayQty = storageQty ?? monthlyTotal;
  } else if (monthsPresent) {
    tco2e = monthly(); displayQty = monthlyTotal;
  } else {
    tco2e = annual(); displayQty = storageQty ?? monthlyTotal;
  }
  return { tco2e, notReplayable: [...flags].sort(), displayQty };
}

export type RegisterSourceInput = {
  qty: Cell; factor: Cell; ghgUnit: Cell; applyPct: Cell; calcTco2e: Cell;
};

/** A register source's figure, as `combined_row_metrics` computes it (group values already coalesced in). */
export function registerSourceFigure(source: RegisterSourceInput): number {
  const qty = orDefault(pyFloat(source.qty), 0);
  const factor = pyFloat(source.factor);
  const applyPct = orDefault(pyFloat(source.applyPct), 100);
  const unit = source.ghgUnit?.trim() || null;
  let calc = pyFloat(source.calcTco2e);
  if (calc === null) {
    calc = qty * (factor ?? 0) * (applyPct / 100);
    if ((unit || "kgCO2e").toLowerCase().includes("kg")) calc /= 1000;
  }
  return calc || 0;
}

/** `_build_scope_summary`'s totals: each row rounded then summed per scope and rounded; the grand total from raw. */
export function scopeTotals(figures: ReadonlyArray<{ scope: Cell; tco2e: number }>):
  { "Scope 1": number; "Scope 2": number; "Scope 3": number; Total: number } {
  const perScope = new Map<string, number>();
  let raw = 0;
  for (const figure of figures) {
    const cleaned = (figure.scope ?? "").trim();
    const scopeName = !cleaned || ["nan", "none", "null"].includes(cleaned.toLowerCase()) ? "Unknown" : cleaned;
    raw += figure.tco2e;
    perScope.set(scopeName, (perScope.get(scopeName) ?? 0) + pyRound2(figure.tco2e));
  }
  const total = (name: string) => (perScope.has(name) ? pyRound2(perScope.get(name)!) : 0);
  return { "Scope 1": total("Scope 1"), "Scope 2": total("Scope 2"), "Scope 3": total("Scope 3"), Total: pyRound2(raw) };
}
