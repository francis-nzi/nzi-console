// The real DESNZ 2019 conversion factors, and the pure plan that aligns v7's `uk-ghg-gb-2019` to them (RULING 30 Oct 2026, Cowork).
// v7 imported "2019" from a file with no row ids and ended up with a copy of the 2020 edition (about 89% of its rows equal 2020's). The
// ruling is: align in place — keep every factor id, correct its value to the real 2019 number — so nothing re-points and the only thing
// that moves is the value. This module is the no-database half: the flat file's rows, the join from a stored factor to a real row, the
// three named rules, and the correction report (the artefact that is signed before anything is written).
//
// The join is the sheet's own composite key. DESNZ 2019 carries no ids, so a stored factor is matched on scope + the level path (Level 1–4
// then Column Text, as v7 spread them) + the unit + the gas (kg CO2e). Exactly one real row is a match; none or several is reported and
// left alone — a factor is never guessed. The three rules the ruling names are explicit, tested exceptions:
//   air   — the sheet gives With RF and Without RF; the library is with-RF only (D5), so With RF;
//   gas   — Net CV and Gross CV both exist; the label names which ("kWh (Gross CV)"), so the label decides;
//   waste — 2019 has no "Household residual waste"; "Refuse › Municipal waste › Combustion" is DEFRA's earlier name for the same activity
//           (a documented cross-edition rename, not a clean key match).
// No id is added or retired, no formula is touched, and a factor with no real counterpart is reported, not zeroed.
import { createHash } from "node:crypto";

export const FLAT_FILE_NAME = "conversion-factors-2019-flat-file-v01-02.xls";
export const FLAT_SHEET = "Factors by Category";
const GHG_CO2E = "kg co2e";

export type FlatRow = { scope: string; l1: string; l2: string; l3: string; l4: string; columnText: string; uomSimple: string; uom: string; ghg: string; lookup: string; value: number | null; rawValue: string };
export type FlatDocument = {
  source: { file: string; sheet: string; sha256: string; sheetDataRows: number; header: string[] };
  rows: Array<Array<string | number>>;
};
export type FlatFile = { source: FlatDocument["source"]; rows: FlatRow[]; blankValueRows: number; co2eRows: FlatRow[] };

export class FlatFileRefused extends Error {}

const norm = (text: unknown) => String(text ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The sheet's composite natural key (the ruling's: Scope, L1–L4, Column Text, UOM, GHG). */
export const flatKey = (row: FlatRow) => [row.scope, row.l1, row.l2, row.l3, row.l4, row.columnText, row.uom, row.ghg].map(norm).join(" ¦ ");
const displayPath = (row: FlatRow) => [row.l1, row.l2, row.l3, row.l4, row.columnText].filter((part) => part.trim() !== "").join(" › ");

/** Parse the committed extract. A duplicate composite key refuses (nothing is guessed); a blank or non-numeric value is kept with a null value — counted, matched, reported, never read as zero. */
export function parseFlatFile(doc: FlatDocument): FlatFile {
  if (doc.source.file !== FLAT_FILE_NAME || doc.source.sheet !== FLAT_SHEET) throw new FlatFileRefused(`the extract is not ${FLAT_FILE_NAME} / ${FLAT_SHEET}.`);
  const rows: FlatRow[] = []; let blankValueRows = 0;
  for (const raw of doc.rows) {
    const text = (index: number) => String(raw[index] ?? "").trim();
    const value = raw[10];
    const numeric = typeof value === "number" && Number.isFinite(value);
    if (!numeric) blankValueRows += 1;
    rows.push({ scope: text(0), l1: text(1), l2: text(2), l3: text(3), l4: text(4), columnText: text(5), uomSimple: text(6), uom: text(7), ghg: text(8), lookup: text(9),
      value: numeric ? (value as number) : null, rawValue: String(value ?? "") });
  }
  if (rows.length !== doc.source.sheetDataRows) throw new FlatFileRefused(`the extract holds ${rows.length} rows, its header says ${doc.source.sheetDataRows}.`);
  const seen = new Map<string, FlatRow>();
  for (const row of rows) {
    const key = flatKey(row);
    if (seen.has(key)) throw new FlatFileRefused(`duplicate composite key in the flat file: ${key}`);
    seen.set(key, row);
  }
  return { source: doc.source, rows, blankValueRows, co2eRows: rows.filter((row) => norm(row.ghg) === GHG_CO2E) };
}

export type StoredFactor = {
  datasetId: string; factorId: string; label: string; activityUnit: string; value: string; scopes: string[]; active: boolean;
  sourceLevels: string[]; usedRows: number;
};

export type MatchKind = "KEY" | "RULE_AIR_WITH_RF" | "RULE_GAS_GROSS_CV" | "RULE_WASTE_RENAME" | "UNMATCHED" | "AMBIGUOUS" | "NZI_CUSTOM" | "BLANK_IN_SOURCE";
export type CorrectionLine = {
  datasetId: string; factorId: string; path: string; unit: string; active: boolean; usedRows: number;
  oldValue: string; newValue: string | null; pctChange: number | null; changes: boolean;
  match: MatchKind; flatKey: string | null; note: string;
};
export type CorrectionPlan = {
  flatSha256: string; lines: CorrectionLine[]; sha256: string;
  counts: Record<MatchKind, number> & { changed: number; alreadyEqual: number; inUse: number; inUseChanged: number };
};

const UNIT_ALIASES: Record<string, string> = { m3: "cubic metres", nights: "room per night", litre: "litres", tonne: "tonnes" };
const unitOf = (text: string) => { const key = norm(text); return UNIT_ALIASES[key] ?? key; };
const labelSuffix = (label: string) => /\s—\s(.+)$/.exec(label)?.[1] ?? null;

function candidates(stored: StoredFactor, flat: FlatFile): FlatRow[] {
  const want = stored.scopes[0];
  const suffix = labelSuffix(stored.label);
  const unit = unitOf(stored.activityUnit);
  return flat.co2eRows.filter((row) => {
    const scope = norm(row.scope);
    if (!(scope === `scope ${want}` || (want === "3" && scope === "outside of scopes"))) return false;
    // v7 spread the path over four levels, the Column Text standing in when Level 4 is empty; a trailing level that is just the unit is dropped.
    const slots = [row.l1, row.l2, row.l3, row.l4, row.columnText].map(norm).filter((part) => part !== "");
    const levels = stored.sourceLevels.map(norm);
    const trimmed = levels.length > 1 && unitOf(levels[levels.length - 1]!) === unit && !slots.includes(levels[levels.length - 1]!) ? levels.slice(0, -1) : levels;
    if (!trimmed.every((level, index) => slots[index] === level)) return false;
    // The path must be the whole path: at most the Column Text may follow it (it only separates unit or fuel-basis variants, and the unit decides).
    if (slots.length > trimmed.length && !(slots.length === trimmed.length + 1 && norm(row.columnText) !== "" && slots[slots.length - 1] === norm(row.columnText))) return false;
    return suffix ? norm(row.uom) === norm(suffix) : unitOf(row.uomSimple) === unit || unitOf(row.uom) === unit;
  });
}

const isNziCustom = (stored: StoredFactor) => stored.factorId.startsWith("nzi-");
const pct = (oldValue: string, next: number) => (Number(oldValue) === 0 ? null : ((next - Number(oldValue)) / Number(oldValue)) * 100);
const same = (a: string, b: number) => Math.abs(Number(a) - b) <= 1e-9 * Math.max(1, Math.abs(b));

/** The waste rename the ruling accepted: the one in-use "Household residual waste / Combustion" id, to 2019's "Municipal waste / Combustion". */
export const WASTE_RENAME = { factorId: "uk-ghg-20_507_5283_15_1", to: ["Waste disposal", "Refuse", "Municipal waste", "Combustion"] as const };

/** Build the correction plan for the stored factors of the 2019 datasets. Pure and deterministic; the report and its sha come from it. */
export function planCorrection(stored: ReadonlyArray<StoredFactor>, flat: FlatFile): CorrectionPlan {
  const lines: CorrectionLine[] = [];
  for (const factor of [...stored].sort((a, b) => a.datasetId.localeCompare(b.datasetId) || a.factorId.localeCompare(b.factorId))) {
    const base = { datasetId: factor.datasetId, factorId: factor.factorId, path: factor.label, unit: factor.activityUnit, active: factor.active, usedRows: factor.usedRows, oldValue: factor.value };
    const line = (match: MatchKind, row: FlatRow | null, note: string): CorrectionLine => {
      const next = row?.value ?? null;
      return { ...base, newValue: next === null ? null : String(next), pctChange: next === null ? null : pct(factor.value, next), changes: next === null ? false : !same(factor.value, next),
        match, flatKey: row ? flatKey(row) : null, note };
    };
    if (isNziCustom(factor)) { lines.push(line("NZI_CUSTOM", null, "an NZI-defined factor with no counterpart in the DESNZ file; left as it is")); continue; }
    let found = candidates(factor, flat);
    if (found.length === 1 && found[0]!.value === null) { lines.push(line("BLANK_IN_SOURCE", found[0]!, `the real 2019 row carries no number (${found[0]!.rawValue === "" ? "blank" : `"${found[0]!.rawValue}"`}); value left as it is`)); continue; }
    if (found.length === 1) {
      lines.push(line(labelSuffix(factor.label)?.includes("Gross CV") ? "RULE_GAS_GROSS_CV" : "KEY", found[0]!, labelSuffix(factor.label)?.includes("Gross CV") ? "Gross CV, as the label says" : ""));
      continue;
    }
    if (found.length === 2) {
      const withRf = found.filter((row) => norm(row.columnText) === "with rf" && row.value !== null), without = found.filter((row) => norm(row.columnText) === "without rf");
      if (withRf.length === 1 && without.length === 1) { lines.push(line("RULE_AIR_WITH_RF", withRf[0]!, "With RF — the library is with-RF only (D5)")); continue; }
    }
    if (found.length === 0 && factor.factorId === WASTE_RENAME.factorId) {
      const [l1, l2, l3, columnText] = WASTE_RENAME.to;
      found = flat.co2eRows.filter((row) => norm(row.scope) === "scope 3" && norm(row.l1) === norm(l1) && norm(row.l2) === norm(l2) && norm(row.l3) === norm(l3)
        && norm(row.columnText) === norm(columnText) && unitOf(row.uomSimple) === unitOf(factor.activityUnit));
      if (found.length === 1) { lines.push(line("RULE_WASTE_RENAME", found[0]!, `cross-edition rename: 2019's ${l1} › ${l2} › ${l3} › ${columnText} is the activity later editions call Household residual waste / Combustion`)); continue; }
    }
    lines.push(line(found.length === 0 ? "UNMATCHED" : "AMBIGUOUS", null,
      found.length === 0 ? "no real 2019 row on the composite key; value left as it is" : `${found.length} real rows fit (${found.map((row) => displayPath(row)).slice(0, 3).join(" | ")}); value left as it is`));
  }
  const counts = { KEY: 0, RULE_AIR_WITH_RF: 0, RULE_GAS_GROSS_CV: 0, RULE_WASTE_RENAME: 0, UNMATCHED: 0, AMBIGUOUS: 0, NZI_CUSTOM: 0, BLANK_IN_SOURCE: 0, changed: 0, alreadyEqual: 0, inUse: 0, inUseChanged: 0 };
  for (const entry of lines) {
    counts[entry.match] += 1;
    if (entry.newValue !== null) { if (entry.changes) counts.changed += 1; else counts.alreadyEqual += 1; }
    if (entry.usedRows > 0) { counts.inUse += 1; if (entry.changes) counts.inUseChanged += 1; }
  }
  const canonical = lines.map((entry) => [entry.datasetId, entry.factorId, entry.oldValue, entry.newValue ?? "", entry.match, entry.flatKey ?? ""].join("\t")).join("\n");
  return { flatSha256: flat.source.sha256, lines, counts, sha256: sha256(`${flat.source.sha256}\n${canonical}`) };
}

const csvCell = (value: string | number | boolean | null) => { const text = value === null ? "" : String(value); return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };

/** The correction report: id · path · old · new · % change · rows using it, with the match kind and note. */
export function correctionCsv(plan: CorrectionPlan): string {
  const header = "dataset_id,factor_id,path,unit,active,scope_rows,old_value,new_value,pct_change,changes,match,note";
  return [header, ...plan.lines.map((entry) => [entry.datasetId, entry.factorId, entry.path, entry.unit, entry.active, entry.usedRows, entry.oldValue, entry.newValue,
    entry.pctChange === null ? "" : entry.pctChange.toFixed(2), entry.changes, entry.match, entry.note].map(csvCell).join(","))].join("\n") + "\n";
}

export function correctionMarkdown(plan: CorrectionPlan, flat: FlatFile, extra: { generatedFor: string; consumers: string[] }): string {
  const c = plan.counts;
  const row = (entry: CorrectionLine) => `| ${entry.datasetId} | \`${entry.factorId}\` | ${entry.path} | ${entry.unit} | ${entry.usedRows} | ${entry.oldValue} | ${entry.newValue ?? "—"} | ${entry.pctChange === null ? "—" : `${entry.pctChange >= 0 ? "+" : ""}${entry.pctChange.toFixed(2)}%`} | ${entry.match}${entry.note ? ` — ${entry.note}` : ""} |`;
  const table = (entries: CorrectionLine[]) => ["| Dataset | Factor id | Path | Unit | Rows | Old | New | Δ | Match |", "|---|---|---|---|---|---|---|---|---|", ...entries.map(row)].join("\n");
  const inUse = plan.lines.filter((entry) => entry.usedRows > 0);
  const named = plan.lines.filter((entry) => entry.match.startsWith("RULE_"));
  const custom = plan.lines.filter((entry) => entry.match === "NZI_CUSTOM");
  return [
    "# Correction report — align v7 `uk-ghg-gb-2019` (and `nzi-gb-2019`) to the real DESNZ 2019", "",
    `Plan sha256 \`${plan.sha256}\` · source \`${flat.source.file}\` (sha256 \`${plan.flatSha256}\`) · sheet "${flat.source.sheet}", ${flat.source.sheetDataRows} data rows (${flat.rows.length - flat.blankValueRows} with a number, ${flat.blankValueRows} blank or non-numeric; ${flat.co2eRows.length} kg CO2e).`,
    `${extra.generatedFor}. Consumers of the two datasets now: ${extra.consumers.join(", ") || "none"}.`, "",
    "## Summary", "",
    `- ${plan.lines.length} stored factors: **${c.changed} change value**, ${c.alreadyEqual} already equal the real 2019 number, ${c.UNMATCHED} have no real counterpart, ${c.AMBIGUOUS} fit more than one real row, ${c.BLANK_IN_SOURCE} match a real row that carries no number, ${c.NZI_CUSTOM} are NZI-defined.`,
    `- In use (drive scope rows): **${c.inUse} factors, ${c.inUseChanged} change.** Unused factors are aligned where a match exists and reported where not; no id is added or retired.`,
    `- Match kinds: ${c.KEY} clean key · ${c.RULE_AIR_WITH_RF} air With RF · ${c.RULE_GAS_GROSS_CV} gas Gross CV · ${c.RULE_WASTE_RENAME} waste rename.`, "",
    "## The factors in use", "", table(inUse), "",
    "## Named rules applied", "", named.length ? table(named) : "None.", "",
    "## NZI-defined factors (not in the DESNZ file — flagged, not guessed)", "",
    custom.length ? table(custom) : "None.", "",
    "## Not changed", "",
    `- ${c.UNMATCHED} unmatched and ${c.AMBIGUOUS} ambiguous factors keep their stored value; they are listed in \`desnz-2019-correction.csv\` with the reason. Revisit a full rebuild only if a later job needs one of them.`, "",
  ].join("\n");
}
