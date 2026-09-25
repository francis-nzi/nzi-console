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
 * Two kinds of finding: a **refusal** stops the load (the plan is not safe to write), a **report** is shown and the load
 * goes ahead (a data question for a person, with nothing mis-priced meanwhile).
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
 * Rulings on editions that fold together, applied by default (ruled 25 Sep 2026). Each uk-ghg year from 2022 to 2025 is
 * split across two v7 datasets (8+1, 9+2, 10+3, 11+4) that share almost no codes: complementary halves of one year's
 * set, not successive editions, so they merge — superseding one would hide real factors. A precedence file passed to
 * the load adds rulings, or overrides one of these by naming the slug.
 */
export const RULED_PRECEDENCE: Readonly<Record<string, string>> = {
  "uk-ghg-gb-2022": "merge", "uk-ghg-gb-2023": "merge", "uk-ghg-gb-2024": "merge", "uk-ghg-gb-2025": "merge",
};

/** v7 uom → the console unit registry's spelling (ruled). Anything absent loads verbatim and is reported. */
export const UNITS: Readonly<Record<string, string>> = {
  kg: "kg", km: "km", miles: "miles", m2: "m2", litres: "litres", kwh: "kWh", "passenger.km": "passenger.km",
  "tonne.km": "tonne.km", tonne: "tonne", tonnes: "tonnes", "cubic metres": "m3", each: "units", unit: "units",
  "room per night": "nights", "kwh (gross cv)": "kWh", "kwh (net cv)": "kWh",
};
const CALORIFIC = /^kwh \((gross|net) cv\)$/;
const CURRENCY = /^[A-Z]{3}$/;

const SCOPES: Readonly<Record<string, string>> = { "scope 1": "1", "scope 2": "2", "scope 3": "3" };

// ── Cleaning ────────────────────────────────────────────────────────────────────────────────────────────────

/** v7 writes absence three ways: empty, the string "NaN", the string "null". All three are SQL NULL; nothing else is. */
export const clean = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "NaN" || trimmed === "null" ? null : trimmed;
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
  factorId: string; label: string; reportLabel: string | null; businessCategory: string | null; levels: string[];
  sourceLabel: string; sourceFamily: string; legacyOriginalId: string; legacyDbId: string;
};
export type PlannedFactor = {
  datasetId: string; factorId: string; label: string; activityUnit: string; kgco2ePerUnit: string; scopes: string[];
  sourceLevels: string[]; sourceCategory: string | null; ghgUnit: string; legacyOriginalId: string; legacyDbId: string;
};
export type Finding = { code: string; message: string; count: number; examples: string[] };
export type LoadPlan = {
  organisationId: string;
  datasets: PlannedDataset[]; identities: PlannedIdentity[]; factors: PlannedFactor[];
  refusals: Finding[]; reports: Finding[];
  summary: {
    extracted: number; duplicatesCollapsed: number; skippedNotKgco2e: number; loaded: number;
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
    if (ghgUnit !== "kgCO2e") { skippedNotKgco2e += 1; report("not-kgco2e", "rows not in kgCO2e are not emission factors and are not loaded", `${dbId}: ${ghgUnit}`); continue; }
    const code = clean(row.original_id);
    const sourceName = clean(row.source);
    const family = familyOf(sourceName);
    const year = clean(row.year);
    const v7Dataset = clean(row.dataset_id);
    const factor = clean(row.factor);
    const scopeRaw = clean(row.scope);
    const scope = scopeRaw ? SCOPES[scopeRaw.toLowerCase()] ?? null : null;
    const uomRaw = clean(row.uom);
    if (!code) { refuse("no-code", "a row has no original_id", dbId); continue; }
    if (!family) { refuse("unknown-source", "a source that is not in the family map", `${dbId}: ${sourceName}`); continue; }
    if (!year || !/^\d{4}$/.test(year)) { refuse("no-year", "a row without a four-digit year", dbId); continue; }
    if (!v7Dataset) { refuse("no-dataset", "a row without a dataset_id", dbId); continue; }
    if (!scope) { refuse("unknown-scope", "a scope that is not Scope 1, 2 or 3", `${dbId}: ${scopeRaw}`); continue; }
    if (!uomRaw) { refuse("no-unit", "a row without a unit", dbId); continue; }
    if (!factor || !/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(factor)) { refuse("bad-factor", "a factor that is not a number", `${dbId}: ${factor}`); continue; }
    if (Number(factor) < 0) { refuse("negative-factor", "a negative factor", `${dbId}: ${factor}`); continue; }
    const normalised = normaliseCode(code);
    if (!normalised || /[:|\s]/.test(normalised)) { refuse("unsafe-code", "a code that cannot be a factor id (empty, or with ':', '|' or whitespace)", `${dbId}: ${code}`); continue; }
    if (/-w$/.test(normalised)) report("w-suffix", "a code ending in -w, the retired waste variant", `${dbId}: ${code}`);

    // The country: the region named in words; for IEA, whose region is empty, the code itself is the country; otherwise
    // an empty region takes its family's default, reported — except swc and ceda, which have none and are refused. A name
    // that cannot be matched is refused, never guessed.
    const region = clean(row.region);
    if (!region) emptyRegionByFamily[family] = (emptyRegionByFamily[family] ?? 0) + 1;
    const named = region ?? (family === "iea" ? code : null);
    if (!named && !DEFAULT_COUNTRY[family]) {
      refuse("no-country", `a ${family} row with no region: a spend factor must name its country or "Rest of World" — defaulting it would attach it to every job`, `${dbId}: ${code}`);
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
      sourceLevels: levels, sourceCategory: category, ghgUnit, legacyOriginalId: code, legacyDbId: dbId,
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
          if (seen.kgco2ePerUnit !== row.kgco2ePerUnit || seen.activityUnit !== row.activityUnit) {
            conflicts.push(`${row.factorId}: ${seen.kgco2ePerUnit} ${seen.activityUnit} vs ${row.kgco2ePerUnit} ${row.activityUnit}`);
          } else {
            report("merge-duplicate", "a code carried by both merged v7 datasets at the same value: loaded once",
              `${base}: ${row.factorId} — db ${seen.legacyDbId} loaded, db ${row.legacyDbId} not`);
          }
        }
        if (conflicts.length > 0) {
          refuse("merge-conflict", "a merge ruled for datasets that price a shared code differently", `${base}: ${conflicts.slice(0, 3).join("; ")}`);
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

  // 5. One identity per code within its family: consistent unit and scope everywhere it appears (refused otherwise —
  //    a code reused for a different thing would price one of them wrongly); category or wording drift is reported.
  const byIdentity = new Map<string, Row[]>();
  for (const row of kept as Row[]) byIdentity.set(row.factorId, [...(byIdentity.get(row.factorId) ?? []), row]);
  const identities: PlannedIdentity[] = [];
  for (const [factorId, group] of [...byIdentity].sort(([a], [b]) => a.localeCompare(b))) {
    // A spend factor is priced in its country's currency — CEDA's code 561600 is XCD in Antigua and USD for the rest of the
    // world — so currencies count as one unit here. Any other change of unit is a code reused for something else.
    const units = new Set(group.map((row) => (CURRENCY.test(row.activityUnit) ? "money" : row.activityUnit)));
    const scopes = new Set(group.map((row) => row.scopes.join("+")));
    if (units.size > 1 || scopes.size > 1) {
      refuse("code-reused", "one code with different units or scopes across datasets", `${factorId}: ${[...units].join("/")} ${[...scopes].join("/")}`);
    }
    if (new Set(group.map((row) => row.sourceCategory)).size > 1) report("category-drift", "one code with different categories across datasets", factorId);
    // The identity takes its curated fields from the most recent row carrying the code.
    const latest = [...group].sort((a, b) => b.year.localeCompare(a.year) || Number(b.legacyDbId) - Number(a.legacyDbId))[0]!;
    const lowestDbId = [...group].map((row) => row.legacyDbId).sort((a, b) => Number(a) - Number(b))[0]!;
    identities.push({
      factorId, label: latest.label, reportLabel: latest.reportLabel, businessCategory: latest.sourceCategory,
      levels: latest.sourceLevels, sourceLabel: latest.column, sourceFamily: latest.family,
      legacyOriginalId: latest.code, legacyDbId: lowestDbId,
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
    refusals: [...refusals.values()], reports: [...reports.values()],
    summary: { extracted: rows.length, duplicatesCollapsed, skippedNotKgco2e, loaded: refusals.size ? 0 : factors.length, emptyRegionByFamily },
  };
}
