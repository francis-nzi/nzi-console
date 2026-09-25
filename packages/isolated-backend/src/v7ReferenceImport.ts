import { createHash } from "node:crypto";
import { parseFactorId, type CategoryVariant } from "@nzi/contracts";
import { countryCodeFor } from "./v7Countries";

/**
 * The v7 reference-data transform (REFERENCE_DATA_DESIGN §3–5): an extract of v7's `factor_lookup` in, a validated load
 * plan out. Pure — no database — so every rule below is tested directly, and a dry run shows exactly what a load would
 * write before anything is written.
 *
 * The source of record is `factor_lookup`: its category is the operationally correct, suffix-aware one, and where the
 * definitions disagree it wins (the disagreement is counted, never "corrected"). Each row becomes one value row; each
 * source code within a source family becomes one identity; each family, country and year becomes one dataset, with
 * the rules for editions that fold together applied here.
 *
 * Three kinds of finding: a **refusal** stops the load (the plan is not safe to write); an **exclusion** skips one row for
 * one of a fixed list of named reasons (`EXCLUSION_REASONS`) and lists it in the auditable exclusion report, and the load
 * goes ahead; a **report** is shown and the load goes ahead (a data question for a person, with nothing mis-priced
 * meanwhile).
 */

export const SOURCE_SYSTEM = "nzi-pro-v7";
export const DEFAULT_ORGANISATION = "net-zero-international";

/** One row of the extract, as read: every field a string, nothing coerced yet. */
export type ExtractRow = Record<string, string>;

/** Source → family (ruled). Matched on the start of the source name, case-insensitively. */
export const FAMILIES: ReadonlyArray<readonly [prefix: string, family: string]> = [
  ["desnz", "uk-ghg"], ["defra", "uk-ghg"], ["iea", "iea"], ["ceda", "ceda"], ["rics", "ice"], ["bre", "ice"],
  ["ice", "ice"], ["swc", "swc"], ["small world", "swc"], ["nzi", "nzi"],
];

/**
 * The country a dataset belongs to when the row's region is empty (ruled 25 Sep 2026). **swc and ceda have none, on
 * purpose**: both are multi-country spend providers, so a defaulted — in effect global — spend factor would attach to
 * every job and double-count. An swc or ceda row without a country is refused as a data gap; it must name its country
 * or "Rest of World". Every default that is used is reported.
 */
export const DEFAULT_COUNTRY: Readonly<Record<string, string>> = {
  "uk-ghg": "GB", nzi: "GB", ice: "GLOBAL", iea: "GLOBAL",
};

/**
 * Rulings on editions that fold together, applied by default (ruled 25 Sep 2026). uk-ghg and nzi carry each year from
 * 2021 to 2026 in two v7 datasets (1+8, 2+9, 3+10, 4+11, 5+12, 69+70). The full extract shows the second is a duplicate
 * upload (v7's tmp*.csv): a subset of the first at identical values. Merging is correct either way — a shared code
 * loads once, a code in only one half still loads — and the guard stays: a shared code priced or scoped differently
 * refuses the merge. A precedence file passed to the load adds rulings, or overrides one of these by naming the slug.
 */
export const RULED_PRECEDENCE: Readonly<Record<string, string>> = Object.fromEntries(
  ["2021", "2022", "2023", "2024", "2025", "2026"].flatMap((year) => [[`uk-ghg-gb-${year}`, "merge"], [`nzi-gb-${year}`, "merge"]]),
);

/** v7 uom → the console unit registry's spelling (ruled). Anything absent loads verbatim and is reported. */
export const UNITS: Readonly<Record<string, string>> = {
  kg: "kg", km: "km", miles: "miles", m2: "m2", litres: "litres", kwh: "kWh", "passenger.km": "passenger.km",
  "tonne.km": "tonne.km", tonne: "tonne", tonnes: "tonnes", "cubic metres": "m3", each: "units", unit: "units",
  "room per night": "nights", "kwh (gross cv)": "kWh", "kwh (net cv)": "kWh",
};
const CALORIFIC = /^kwh \((gross|net) cv\)$/;
const CURRENCY = /^[A-Z]{3}$/;

/** A bare "1", "2" or "3" is v7's shorthand for the scope (two DEFRA rows); it is normalised and reported. */
const SCOPES: Readonly<Record<string, string>> = { "scope 1": "1", "scope 2": "2", "scope 3": "3", 1: "1", 2: "2", 3: "3" };

/**
 * Suffixes v7 wrote that the variant registry does not know, mapped to the registered variant they mean (ruled 25 Sep
 * 2026). A transform alias only: the registry gains no entry, and the code v7 wrote is still stored verbatim.
 */
export const SUFFIX_ALIASES: Readonly<Record<string, string>> = { "-cv": "-vcp" };

// ── Cleaning ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * v7 writes absence as empty or as a spelling of null — "NaN", "nan", "null", "None", in any case (ruled 25 Sep 2026).
 * All are SQL NULL; nothing else is. Case matters: "Green gas|NaN|" and "Green gas|nan|" are the same category.
 */
const NULL_SPELLINGS = /^(nan|null|none)$/i;
export const clean = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" || NULL_SPELLINGS.test(trimmed) ? null : trimmed;
};

/**
 * The code as it appears in the id (ruled). Trim and collapse whitespace. A code with no digit in it is a name — IEA
 * keys its grid factors by country ("Puerto Rico") — and is lower-cased and hyphenated, with accents folded, so it is a
 * stable slug. Every other code (DESNZ's "21_316_3178_11_1", "SPEND-SIC-49.3-5-u", ICE's "1") is kept exactly, case
 * included, because its suffix is part of what it means. The code itself is stored verbatim beside the id, which is
 * what makes this reversible.
 */
export function normaliseCode(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, " ");
  if (/\d/.test(collapsed)) return collapsed.replace(/ /g, "-");
  return collapsed.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export const familyOf = (source: string | null): string | null => {
  if (!source) return null;
  const lower = source.toLowerCase();
  return FAMILIES.find(([prefix]) => lower.startsWith(prefix))?.[1] ?? null;
};

// ── CSV ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** RFC 4180: quoted fields, doubled quotes, commas and newlines inside quotes. The first row is the header. */
export function parseCsv(text: string): ExtractRow[] {
  const records: string[][] = [];
  let field = "", record: string[] = [], quoted = false;
  const body = text.replace(/^﻿/, "");
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (quoted) {
      if (char === "\"" && body[index + 1] === "\"") { field += "\""; index += 1; }
      else if (char === "\"") quoted = false;
      else field += char;
    } else if (char === "\"") quoted = true;
    else if (char === ",") { record.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && body[index + 1] === "\n") index += 1;
      record.push(field); field = "";
      if (record.some((cell) => cell !== "")) records.push(record);
      record = [];
    } else field += char;
  }
  record.push(field);
  if (record.some((cell) => cell !== "")) records.push(record);
  const [header, ...rows] = records;
  if (!header) return [];
  return rows.map((cells) => Object.fromEntries(header.map((name, column) => [name.trim(), cells[column] ?? ""])));
}

// ── The plan ────────────────────────────────────────────────────────────────────────────────────────────────

export type PlannedDataset = {
  datasetId: string; name: string; version: string; validFrom: string; validTo: string; countryCode: string;
  status: "active" | "superseded"; sourceName: string; licence: string; sourceFamily: string; legacyDatasetId: string;
  contentSha256: string;
};
export type PlannedIdentity = {
  /** The union of its value rows' scopes, for display. Not written: scope lives on each value row. */
  factorId: string; scopes: string[]; label: string; reportLabel: string | null; businessCategory: string | null; levels: string[];
  sourceLabel: string; sourceFamily: string; legacyOriginalId: string; legacyDbId: string;
};
export type PlannedFactor = {
  datasetId: string; factorId: string; label: string; activityUnit: string; kgco2ePerUnit: string; scopes: string[];
  sourceLevels: string[]; sourceCategory: string | null; ghgUnit: string; legacyOriginalId: string; legacyDbId: string;
};
export type Finding = { code: string; message: string; count: number; examples: string[] };

/**
 * The only reasons a row may be **excluded** — skipped, and listed row by row in the exclusion report — rather than
 * refused (ruled 25 Sep 2026). A fixed, named list: a row that fails for any reason not here still refuses the whole
 * load, so a new kind of bad row halts it rather than disappearing.
 */
export const EXCLUSION_REASONS = {
  "factor-missing": "a row with no factor value (empty or NaN): there is nothing to load",
  "column-shifted": "a currency that is not a three-letter code — the row's columns are shifted, so none of its fields can be trusted",
  "swc-no-country": "an swc row with no region: SWC is unused, and a spend factor with no country would attach to every job",
  "not-kgco2e": "a row not in kgCO2e: not an emission factor",
  "retired-w": "a code ending in -w, the retired waste variant",
  "duplicate-upload-unit-conflict": "a ruled duplicate-upload row whose unit contradicts the xlsx edition at a value of 0: the xlsx row loads",
} as const;

/**
 * The rows excluded as `duplicate-upload-unit-conflict` (ruled 25 Sep 2026), by db_id: nzi Walking and Cycling priced
 * at 0 in passenger.km by v7's tmp*.csv duplicate uploads, where the xlsx edition of the same year says miles. Keyed to
 * these ids and nothing else, and self-checking: each is excluded only while its value is 0 and its xlsx miles
 * counterpart (same code and year, another v7 dataset, value 0) is in the extract. Otherwise it refuses.
 */
export const DUPLICATE_UPLOAD_UNIT_CONFLICTS: ReadonlySet<string> = new Set(["31415", "31416", "21722", "21723"]);
export type ExclusionReason = keyof typeof EXCLUSION_REASONS;
/** One excluded row, for the auditable exclusion report. */
export type ExcludedRow = { dbId: string; reason: ExclusionReason; originalId: string | null; source: string | null; detail: string };

export type LoadPlan = {
  organisationId: string;
  datasets: PlannedDataset[]; identities: PlannedIdentity[]; factors: PlannedFactor[];
  /** Refusals block the load. Exclusions do not: each excluded row is listed in `excluded`. Reports are shown. */
  refusals: Finding[]; exclusions: Finding[]; excluded: ExcludedRow[]; reports: Finding[];
  summary: {
    extracted: number; duplicatesCollapsed: number; skippedNotKgco2e: number; loaded: number;
    /** Cells written as a spelling of null ("NaN", "nan"…) and read as NULL, by spelling; and the rows carrying any. */
    nulledCells: Record<string, number>; rowsWithNulledCells: number;
    /** Rows with an empty region, per family — counted even when none, so a zero is visible rather than assumed. */
    emptyRegionByFamily: Record<string, number>;
  };
};

/**
 * What happens when two v7 datasets fold into one family, country and year. The rule (ruled 25 Sep 2026): a revision
 * beats the edition it revises; otherwise the later edition wins. Anything the rule cannot order is refused unless
 * Francis has ruled it in `precedence`, per dataset slug:
 *
 * - `"<v7 dataset_id>"` — that edition is active and the other is superseded;
 * - `"merge"` — the two are complementary halves of one set (v7 split some years across two datasets that share few or
 *   no codes), so they load as one dataset. A code carried by both at the same value loads once, reported; a code
 *   carried by both at different values refuses the merge.
 */
export type Precedence = Readonly<Record<string, string>>;

const licenceFor = (sourceName: string) =>
  `Source: ${sourceName}. Free public information, reproduced with attribution for open stakeholder verification.`;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function planV7Load(
  rows: readonly ExtractRow[],
  registry: readonly CategoryVariant[],
  options: { organisationId?: string; precedence?: Precedence } = {},
): LoadPlan {
  const refusals = new Map<string, Finding>(), reports = new Map<string, Finding>();
  const precedence: Precedence = { ...RULED_PRECEDENCE, ...options.precedence };
  const emptyRegionByFamily: Record<string, number> = Object.fromEntries(FAMILIES.map(([, family]) => [family, 0]));
  const note = (into: Map<string, Finding>, code: string, message: string, example: string) => {
    const found = into.get(code) ?? { code, message, count: 0, examples: [] };
    found.count += 1;
    if (found.examples.length < 5) found.examples.push(example);
    into.set(code, found);
  };
  const refuse = (code: string, message: string, example: string) => note(refusals, code, message, example);
  const report = (code: string, message: string, example: string) => note(reports, code, message, example);
  const exclusions = new Map<string, Finding>();
  const excluded: ExcludedRow[] = [];
  const exclude = (reason: ExclusionReason, dbId: string, row: ExtractRow, detail: string) => {
    note(exclusions, reason, EXCLUSION_REASONS[reason], `${dbId}: ${detail}`);
    excluded.push({ dbId, reason, originalId: clean(row.original_id), source: clean(row.source), detail });
  };

  const nulledCells: Record<string, number> = {};
  let rowsWithNulledCells = 0;
  for (const row of rows) {
    let any = false;
    for (const value of Object.values(row)) {
      const trimmed = value.trim();
      if (NULL_SPELLINGS.test(trimmed)) { nulledCells[trimmed] = (nulledCells[trimmed] ?? 0) + 1; any = true; }
    }
    if (any) rowsWithNulledCells += 1;
  }

  // 1. One row per factor_lookup row. An identical repeat (an extract that joined twice) collapses; a conflicting one
  //    is refused, because two different rows cannot both be db_id n.
  const byDbId = new Map<string, ExtractRow>();
  let duplicatesCollapsed = 0;
  for (const row of rows) {
    const dbId = clean(row.db_id);
    if (!dbId) { refuse("no-db-id", "a row has no db_id, so nothing can point back at it", JSON.stringify(row).slice(0, 120)); continue; }
    const seen = byDbId.get(dbId);
    if (!seen) { byDbId.set(dbId, row); continue; }
    if (JSON.stringify(seen) === JSON.stringify(row)) duplicatesCollapsed += 1;
    else refuse("db-id-conflict", "one db_id appears twice with different content", dbId);
  }

  // 2. Rows → value rows, grouped by (family, country, year, v7 dataset).
  type Row = PlannedFactor & { family: string; country: string; year: string; v7Dataset: string; sourceName: string;
    validFrom: string | null; validTo: string | null; fileName: string | null; reportLabel: string | null; code: string; column: string };
  const planned: Row[] = [];
  let skippedNotKgco2e = 0;
  for (const [dbId, row] of byDbId) {
    const ghgUnit = clean(row.ghg_unit);
    if (ghgUnit !== "kgCO2e") { skippedNotKgco2e += 1; exclude("not-kgco2e", dbId, row, `ghg_unit ${ghgUnit}`); continue; }
    if (DUPLICATE_UPLOAD_UNIT_CONFLICTS.has(dbId)) {
      const isZero = (value: string | undefined) => { const cleaned = clean(value); return cleaned !== null && Number(cleaned) === 0; };
      const counterpart = [...byDbId.values()].find((other) => other !== row && clean(other.original_id) === clean(row.original_id)
        && clean(other.year) === clean(row.year) && clean(other.dataset_id) !== clean(row.dataset_id)
        && clean(other.uom)?.toLowerCase() === "miles" && /\.xlsx$/i.test(clean(other.file_name) ?? "") && isZero(other.factor));
      if (isZero(row.factor) && counterpart) {
        exclude("duplicate-upload-unit-conflict", dbId, row, `${clean(row.original_id)} ${clean(row.year)} 0 ${clean(row.uom)} — db ${clean(counterpart.db_id)} (xlsx, 0 miles) loads`);
        continue;
      }
      refuse("ruled-exclusion-unverified", "a row ruled excluded as a duplicate-upload unit conflict no longer matches the ruling (value not 0, or no xlsx miles counterpart)", `${dbId}: ${clean(row.original_id)} ${clean(row.factor)} ${clean(row.uom)}`);
      continue;
    }
    const verbatimCode = clean(row.original_id);
    const aliased = verbatimCode ? Object.entries(SUFFIX_ALIASES).find(([from]) => verbatimCode.endsWith(from)) : undefined;
    const code = aliased ? `${verbatimCode!.slice(0, -aliased[0].length)}${aliased[1]}` : verbatimCode;
    const sourceName = clean(row.source);
    const currency = clean(row.currency);
    const family = familyOf(sourceName);
    const year = clean(row.year);
    const v7Dataset = clean(row.dataset_id);
    const factor = clean(row.factor);
    const scopeRaw = clean(row.scope);
    const scope = scopeRaw ? SCOPES[scopeRaw.toLowerCase()] ?? null : null;
    const uomRaw = clean(row.uom);
    if (!code) { refuse("no-code", "a row has no original_id", dbId); continue; }
    // A currency that is not a currency code means the row's columns are shifted: nothing in it can be trusted in place.
    if (currency && !CURRENCY.test(currency)) { exclude("column-shifted", dbId, row, `${code} currency "${currency}", uom "${clean(row.uom)}"`); continue; }
    if (!family) { refuse("unknown-source", "a source that is not in the family map", `${dbId}: ${sourceName}`); continue; }
    if (!year || !/^\d{4}$/.test(year)) { refuse("no-year", "a row without a four-digit year", dbId); continue; }
    if (!v7Dataset) { refuse("no-dataset", "a row without a dataset_id", dbId); continue; }
    if (!scope) { refuse("unknown-scope", "a scope that is not Scope 1, 2 or 3", `${dbId}: ${scopeRaw}`); continue; }
    if (!uomRaw) { refuse("no-unit", "a row without a unit", dbId); continue; }
    if (!factor) { exclude("factor-missing", dbId, row, code); continue; }
    if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(factor)) { refuse("bad-factor", "a factor that is not a number", `${dbId}: ${factor}`); continue; }
    // Negative only for ICE (ruled 25 Sep 2026): its "Including Carbon Storage" values are real sequestration. They load
    // as priced, and are reported, because reporting must treat them as storage/removals, never net them into gross scope
    // totals (GHG Protocol) — REFERENCE_DATA_DESIGN §4. Every other source refuses a negative.
    if (Number(factor) < 0) {
      if (family !== "ice") { refuse("negative-factor", "a negative factor outside ICE", `${dbId}: ${family} ${factor}`); continue; }
      report("ice-negative", "an ICE carbon-storage value below zero: loaded; reporting must treat it as storage/removals, not net it into gross totals", `${dbId}: ${code} ${factor}`);
    }
    const normalised = normaliseCode(code);
    if (!normalised || /[:|\s]/.test(normalised)) { refuse("unsafe-code", "a code that cannot be a factor id (empty, or with ':', '|' or whitespace)", `${dbId}: ${code}`); continue; }
    if (/-w$/.test(normalised)) { exclude("retired-w", dbId, row, code); continue; }
    if (/^\d$/.test(scopeRaw!)) report("scope-normalised", `a bare scope number, read as "Scope n"`, `${dbId}: ${code} "${scopeRaw}" → Scope ${scope}`);
    if (aliased) report("suffix-aliased", "a suffix the registry does not know, loaded as the registered variant it means (the v7 code is kept verbatim)", `${dbId}: ${verbatimCode} → ${code}`);

    // The country: the region named in words; for IEA, whose region is empty, the code itself is the country (so IEA never
    // reaches its GLOBAL default — an unmatched IEA name is refused, or 56 countries would collapse into one); otherwise
    // an empty region takes its family's default, reported — except swc and ceda, which have none: an swc row is
    // excluded (SWC is unused), a ceda row refused. A name that cannot be matched is refused, never guessed.
    const region = clean(row.region);
    if (!region) emptyRegionByFamily[family] = (emptyRegionByFamily[family] ?? 0) + 1;
    const named = region ?? (family === "iea" ? code : null);
    if (!named && family === "swc") { exclude("swc-no-country", dbId, row, code); continue; }
    if (!named && !DEFAULT_COUNTRY[family]) {
      refuse("no-country",`a ${family} row with no region: a spend factor must name its country or "Rest of World" — defaulting it would attach it to every job`, `${dbId}: ${code}`);
      continue;
    }
    const country = named ? countryCodeFor(named) : DEFAULT_COUNTRY[family]!;
    if (!country) { refuse("unknown-country", "a country name that is not in the ISO table or its aliases", `${dbId}: ${named}`); continue; }
    if (!named) report("country-defaulted", `an empty region, placed in its family's default country (${Object.entries(DEFAULT_COUNTRY).map(([f, c]) => `${f} ${c}`).join(", ")})`, `${dbId}: ${family} → ${country}`);

    let unit = UNITS[uomRaw.toLowerCase()];
    let label = clean(row.column_text) ?? clean(row.report_label) ?? code;
    if (unit && CALORIFIC.test(uomRaw.toLowerCase()) && !label.toLowerCase().includes(uomRaw.toLowerCase())) label = `${label} — ${uomRaw}`;
    if (!unit) {
      unit = uomRaw;
      if (CURRENCY.test(uomRaw)) report("currency-unit", "a spend factor priced in a currency: pickable, resolvable once that currency is enabled", `${dbId}: ${uomRaw}`);
      else report("unmapped-unit", "a unit the console registry does not know: loaded verbatim, pickable, never resolved by a rule", `${dbId}: ${uomRaw}`);
    }
    const levels = [row.level_1, row.level_2, row.level_3, row.level_4].map(clean).filter((level): level is string => level !== null);
    const category = clean(row.category);
    const definitionCategory = clean(row.definition_category);
    if (row.definition_category !== undefined && definitionCategory !== category) {
      report("definition-disagrees", "factor_lookup's category differs from the definition's; factor_lookup is kept", `${dbId}: ${definitionCategory} → ${category}`);
    }
    planned.push({
      datasetId: "", factorId: `${family}-${normalised}`, label, activityUnit: unit, kgco2ePerUnit: factor, scopes: [scope],
      sourceLevels: levels, sourceCategory: category, ghgUnit, legacyOriginalId: verbatimCode!, legacyDbId: dbId,
      family, country, year, v7Dataset, sourceName: sourceName!, validFrom: clean(row.valid_from), validTo: clean(row.valid_to),
      fileName: clean(row.file_name), reportLabel: clean(row.report_label), code, column: clean(row.column_text) ?? label,
    });
  }

  // 3. Editions. Every (family, country, year) is one slug; each v7 dataset feeding it is an edition.
  const slug = (row: Row) => `${row.family}-${row.country.toLowerCase()}-${row.year}`;
  const editions = new Map<string, Map<string, Row[]>>();
  for (const row of planned) {
    const bySlug = editions.get(slug(row)) ?? new Map<string, Row[]>();
    const members = bySlug.get(row.v7Dataset) ?? [];
    members.push(row);
    bySlug.set(row.v7Dataset, members);
    editions.set(slug(row), bySlug);
  }
  const datasets: PlannedDataset[] = [];
  const kept: Row[] = [];
  for (const [base, bySource] of [...editions].sort(([a], [b]) => a.localeCompare(b))) {
    const members = [...bySource.entries()];
    let order: string[];
    if (members.length === 1) order = [members[0]![0]];
    else {
      const ruled = precedence[base];
      if (ruled === "merge") {
        const byId = new Map<string, Row>();
        const conflicts: string[] = [];
        const all = members.flatMap(([, group]) => group).sort((a, b) => Number(a.legacyDbId) - Number(b.legacyDbId));
        for (const row of all) {
          const seen = byId.get(row.factorId);
          if (!seen) { byId.set(row.factorId, row); continue; }
          if (seen.kgco2ePerUnit !== row.kgco2ePerUnit || seen.activityUnit !== row.activityUnit || seen.scopes.join("+") !== row.scopes.join("+")) {
            conflicts.push(`${row.factorId}: ${seen.kgco2ePerUnit} ${seen.activityUnit} scope ${seen.scopes.join("+")} vs ${row.kgco2ePerUnit} ${row.activityUnit} scope ${row.scopes.join("+")}`);
          } else {
            report("merge-duplicate", "a code carried by both merged v7 datasets at the same value: loaded once",
              `${base}: ${row.factorId} — db ${seen.legacyDbId} loaded, db ${row.legacyDbId} not`);
          }
        }
        if (conflicts.length > 0) {
          refuse("merge-conflict", "a merge ruled for datasets that price or scope a shared code differently",`${base}: ${conflicts.slice(0, 3).join("; ")}`);
          continue;
        }
        const mergedId = members.map(([id]) => id).sort((a, b) => Number(a) - Number(b)).join("+");
        bySource.clear();
        bySource.set(mergedId, [...byId.values()]);
        order = [mergedId];
      } else {
        const revision = members.filter(([, group]) => group.some((row) => /revision|revised/i.test(`${row.fileName ?? ""} ${row.sourceName}`)));
        if (ruled && bySource.has(ruled)) order = [ruled, ...members.map(([id]) => id).filter((id) => id !== ruled).sort()];
        else if (revision.length === 1) order = [revision[0]![0], ...members.map(([id]) => id).filter((id) => id !== revision[0]![0]).sort()];
        else {
          // Said with the numbers a ruling needs: whether these are two editions of one set (mostly shared, same values)
          // or complementary sets (mostly disjoint), where superseding one would hide real factors.
          const valueOf = (group: Row[]) => new Map(group.map((row) => [row.factorId, row.kgco2ePerUnit]));
          const [first, second] = members.map(([, group]) => valueOf(group));
          const shared = [...first!.keys()].filter((id) => second!.has(id));
          const same = shared.filter((id) => first!.get(id) === second!.get(id)).length;
          refuse("edition-collision", "two v7 datasets fold into one family, country and year and the rule cannot order them — rule it in the precedence file",
            `${base}: v7 datasets ${members.map(([id]) => id).join(", ")} — only in ${members[0]![0]}: ${first!.size - shared.length}, only in ${members[1]![0]}: ${second!.size - shared.length}, shared at the same value: ${same}, shared at a different value: ${shared.length - same}`);
          continue;
        }
      }
    }
    order.forEach((v7Dataset, rank) => {
      const group = bySource.get(v7Dataset)!;
      const datasetId = rank === 0 ? base : `${base}-${rank === 1 && members.length === 2 ? "original" : `edition-${v7Dataset}`}`;
      const first = group[0]!;
      const dates = group.flatMap((row) => [row.validFrom, row.validTo]).filter((date): date is string => date !== null).sort();
      if (dates.length === 0) report("no-validity", "a dataset whose rows carry no validity dates, bounded by its year instead", datasetId);
      const rowsHere = group.map((row) => ({ ...row, datasetId }));
      kept.push(...rowsHere);
      const canonical = [...rowsHere].sort((a, b) => a.factorId.localeCompare(b.factorId))
        .map((row) => [row.factorId, row.kgco2ePerUnit, row.activityUnit, row.scopes.join("+"), row.label, row.legacyDbId].join("\t")).join("\n");
      datasets.push({
        datasetId, name: first.fileName ?? `${first.sourceName} ${first.year}`, version: first.fileName ?? first.year,
        validFrom: dates[0] ?? `${first.year}-01-01`, validTo: dates[dates.length - 1] ?? `${first.year}-12-31`,
        countryCode: first.country, status: rank === 0 ? "active" : "superseded", sourceName: first.sourceName,
        licence: licenceFor(first.sourceName), sourceFamily: first.family, legacyDatasetId: v7Dataset, contentSha256: sha256(canonical),
      });
      if (rank > 0) report("superseded", "an older edition sharing its slug, loaded as superseded", `${datasetId} (v7 dataset ${v7Dataset})`);
    });
  }

  // 4. Within each dataset, one row per code — and no two codes normalising to the same id.
  const perDataset = new Map<string, Map<string, Row>>();
  for (const row of kept as Row[]) {
    const ids = perDataset.get(row.datasetId) ?? new Map<string, Row>();
    const clash = ids.get(row.factorId);
    if (clash) refuse(clash.code === row.code ? "code-twice-in-dataset" : "normalisation-collision",
      clash.code === row.code ? "one code twice in one dataset" : "two codes normalise to the same id",
      `${row.datasetId}: ${clash.code} / ${row.code} → ${row.factorId}`);
    ids.set(row.factorId, row);
    perDataset.set(row.datasetId, ids);
  }

  // 5. One identity per code within its family: a consistent unit everywhere it appears (refused otherwise — a code
  //    reused for a different thing would price one of them wrongly); category or wording drift is reported. Scope may
  //    vary by year (ruled 25 Sep 2026: DEFRA moved spend fuels and energy from Scope 3 to 1/2 in 2025). Scope is a
  //    property of each value row, and the resolver reads it there; a conflict within one dataset is refused in step 3
  //    (a merge) or step 4 (one code twice), so it cannot reach here.
  const byIdentity = new Map<string, Row[]>();
  for (const row of kept as Row[]) byIdentity.set(row.factorId, [...(byIdentity.get(row.factorId) ?? []), row]);
  const identities: PlannedIdentity[] = [];
  for (const [factorId, group] of [...byIdentity].sort(([a], [b]) => a.localeCompare(b))) {
    // A spend factor is priced in its country's currency — CEDA's code 561600 is XCD in Antigua and USD for the rest of the
    // world — so currencies count as one unit here. Any other change of unit is a code reused for something else.
    const units = new Set(group.map((row) => (CURRENCY.test(row.activityUnit) ? "money" : row.activityUnit)));
    if (units.size > 1) refuse("code-reused", "one code with different units across datasets", `${factorId}: ${[...units].join("/")}`);
    const scopes = [...new Set(group.flatMap((row) => row.scopes))].sort();
    if (scopes.length > 1) {
      const byYear = [...new Map([...group].sort((a, b) => a.year.localeCompare(b.year)).map((row) => [row.year, row.scopes.join("+")]))];
      report("scope-by-year", "one code in different scopes in different years: each value row keeps its own", `${factorId}: ${byYear.map(([year, scope]) => `${year} S${scope}`).join(", ")}`);
    }
    if (new Set(group.map((row) => row.sourceCategory)).size > 1) report("category-drift", "one code with different categories across datasets", factorId);
    // The identity takes its curated fields from the most recent row carrying the code.
    const latest = [...group].sort((a, b) => b.year.localeCompare(a.year) || Number(b.legacyDbId) - Number(a.legacyDbId))[0]!;
    const lowestDbId = [...group].map((row) => row.legacyDbId).sort((a, b) => Number(a) - Number(b))[0]!;
    identities.push({
      factorId, scopes, label: latest.label, reportLabel: latest.reportLabel, businessCategory: latest.sourceCategory,
      levels: latest.sourceLevels, sourceLabel: latest.column, sourceFamily: latest.family,
      legacyOriginalId: latest.legacyOriginalId, legacyDbId: lowestDbId,
    });
  }

  // 6. Variants: every id that parses as one should have its base beside it, at the same value and unit.
  const byDatasetId = new Map((kept as Row[]).map((row) => [`${row.datasetId}|${row.factorId}`, row]));
  for (const row of kept as Row[]) {
    const parsed = parseFactorId(row.factorId, registry);
    if (!parsed.variant) {
      if (/-(?:[A-Z]{1,4})$/.test(row.code)) report("upper-case-suffix", "a code ending in an upper-case tag, not read as a variant", row.factorId);
      continue;
    }
    const base = byDatasetId.get(`${row.datasetId}|${parsed.base}`);
    if (!base) report("variant-without-base", "a variant whose base is not in the same dataset", `${row.datasetId}: ${row.factorId}`);
    else if (base.kgco2ePerUnit !== row.kgco2ePerUnit || base.activityUnit !== row.activityUnit) {
      report("variant-differs", "a variant whose value or unit differs from its base", `${row.datasetId}: ${row.factorId}`);
    }
  }

  const factors = (kept as Row[]).map(({ datasetId, factorId, label, activityUnit, kgco2ePerUnit, scopes, sourceLevels, sourceCategory, ghgUnit, legacyOriginalId, legacyDbId }) =>
    ({ datasetId, factorId, label, activityUnit, kgco2ePerUnit, scopes, sourceLevels, sourceCategory, ghgUnit, legacyOriginalId, legacyDbId }));
  return {
    organisationId: options.organisationId ?? DEFAULT_ORGANISATION,
    datasets, identities, factors,
    refusals: [...refusals.values()], exclusions: [...exclusions.values()], excluded, reports: [...reports.values()],
    summary: { extracted: rows.length, duplicatesCollapsed, skippedNotKgco2e, loaded: refusals.size ? 0 : factors.length, emptyRegionByFamily,
      nulledCells, rowsWithNulledCells },
  };
}
