// The import rows modal (BRIEF-v7-import-rows-modal; the agreed flow and mockup in _handoff): one operator task from the job — the
// previous system's rows, each matched to a console factor by its original ID, recomputed, reconciled and accepted.
//
//   1. The read (`readV7ImportRows`, §A) — the mapping view's read (Part 2: the refresh's own read, in a transaction always rolled
//      back), and beside each row its candidates: the console factors found by the row's own ID — the previous system's factor
//      itself (by its lookup row), every factor whose code matches the row's suffix-insensitively, and the row's current mapping —
//      each recomputed for the row and judged against the previous system's figure (`v7MatchCandidate`). A row with exactly one
//      candidate that reproduces on its own basis comes in pre-accepted (decision 1); a right figure on the wrong basis never does
//      (decision 2). No command, no audit, nothing stored.
//   2. The search (`searchV7ImportFactors`, §D) — the factor library by any words of the ID, label, unit and dataset, in any order,
//      as the job's dataset search matches them. A read of the library: nothing of the row is sent, so the modal judges each hit.
//   3. The accept (`acceptV7ImportRows`, §B) — many rows' decisions in one request: each one the existing `import.decision.set`
//      command (0228), keyed by the row id, under its own idempotency key and audit, exactly as the one-row control writes it. No new
//      command, no new authority: the route takes `import.decision.set`'s principal, and each write is that command's own check.
import {
  emissionCategoryTaxonomy, familylessCategories, categoriesForLevels, membersOfCategory, parseFactorId, rankV7Candidates, v7ApplyPct, v7AutoPick, v7CategoryCode,
  v7CodeKeys, v7FactorKeys, v7ImportPeriodIssue, v7MatchCandidate, V7_IMPORT_SOURCE_SYSTEM,
  type CommandContext, type CommandInputMap, type MembershipFactor, type V7ImportCarryState, type V7ImportScope, type V7MatchResult, type V7MatchRow,
} from "@nzi/contracts";
import { assertCapabilityOnClient, type CapabilityHolder } from "./access";
import { AuthorizationError } from "./auth";
import { listCategoryVariants } from "./factorCategoryVariants";
import { listMembershipRules, pairedCategoriesLookup } from "./factorMembershipRead";
import { withTenantRead, withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { CommandValidationError } from "./postgresCommands";
import type { PlannedRow } from "./v7ClientImport";
import { invalidV7ImportMappings, setV7ImportDecision } from "./v7ImportDecision";
import { buildV7ImportMapping, V7_SCOPE_TOTAL_CODE, type V7ImportMapping, type V7ImportMappingRow } from "./v7ImportMapping";
import { readV7ImportPeriod, type V7ImportRefreshOptions, type V7ImportRefreshSource } from "./v7ImportRefresh";
import { v7UnitAgainstFactor } from "./v7Reingest";

/**
 * Where a row stands in the modal:
 *   accepted      — a current decision resolves it (a mapping, or a confirmed withdrawal);
 *   pre-accepted  — needs a mapping, and one candidate found by its ID reproduces cleanly (decision 1): accepted in bulk;
 *   suggested     — needs a mapping; the best candidate is on its basis but not a clean single reproduction: a person confirms;
 *   unmatched     — needs a mapping, and nothing found by its ID will do: a person searches;
 *   confirm-off   — gone from the previous system: a person confirms it goes off;
 *   switched-off  — needs a mapping, but switched off in the previous system (BRIEF-v7-import-rows-autopick-fix §2, ruled 24 Nov):
 *                   mapped to the previous system's own factor and brought in switched off, as it is held there — never counted
 *                   in a scope total, the reconcile or a report; accepted with "Accept all". Its pick is that factor, or none;
 *   in-console    — in the console and unmoved in what its mapping keyed on: carried as it stands;
 *   retiring      — one of the previous system's scope totals, switched off or gone there: it retires when the rows come in.
 */
export const V7_IMPORT_ROW_LANES = ["accepted", "pre-accepted", "suggested", "unmatched", "confirm-off", "switched-off", "in-console", "retiring"] as const;
export type V7ImportRowLane = (typeof V7_IMPORT_ROW_LANES)[number];

export type V7ImportCandidate = {
  datasetId: string; factorId: string; code: string; label: string; unit: string; rate: number; dataset: string;
  /** Found as the previous system's own factor (its lookup row), by its code, or as the row's current mapping. */
  identity: boolean; exactCode: boolean;
  /**
   * The job-year anchor: the previous system's own factor — or, for a variant row, its core code — in the job's reporting-year
   * dataset, at the previous system's own rate (BRIEF-v7-import-rows-autopick-fix §1). Ranked first; auto-picked when it reproduces.
   */
  anchor: boolean;
  /** The dataset's year (the year it is valid from). */
  year: number | null;
  /** Its scope tags, and the categories whose family claims it (with the family-less ones of the row's scope, where it may be filed). */
  scopes: string[]; categories: string[];
  match: V7MatchResult;
  /** Why bringing the row in on it would be refused for its unit (`v7UnitAgainstFactor`, the rule the final check applies), or null. */
  unitRefusal: string | null;
  /** Why a mapping to it would not save (the decision command's own check), or would be refused when brought in (its unit); or null. */
  invalid: string | null;
};

export type V7ImportRowsRow = V7ImportMappingRow & {
  lane: V7ImportRowLane;
  /** The row's input beside its quantity: the apportionment the recompute applies. */
  applyPct: number;
  /** The categories the row is known to belong in, of its scope (its own code, or its levels). */
  categories: string[];
  /** The console category the previous system's own category names for the row, or null (it settles a two-category factor). */
  v7Category: string | null;
  pairGroup: string | null; carry: V7ImportCarryState | null;
  /** Ranked, best first; at most eight. Empty for a row that needs no mapping. */
  candidates: V7ImportCandidate[];
  /** pre-accepted: the auto-pick; suggested: the best candidate; accepted: the decided factor, judged. Otherwise null. */
  pick: V7ImportCandidate | null;
  /** A scope total the previous system still counts beside activity rows of the same scope: bringing it in would count both. */
  totalStillCounted: boolean;
  /**
   * Why the row needs a person although a factor was found for it — bringing it in on that factor would be refused for its unit (its
   * accepted decision included: it goes back to Need a match) — or null. Shown on the row.
   */
  held: string | null;
};

export type V7ImportRows = Omit<V7ImportMapping, "rows"> & {
  rows: V7ImportRowsRow[];
  /** The categories no family names: their list is their whole scope, so any factor of it may be filed there. */
  familyless: string[];
  /**
   * Why the job cannot be brought in for its period (`v7ImportPeriodIssue`: it spans two dataset years, or has none), or null. The
   * refresh refuses such a job whatever the modal shows; the modal says so at the top and shows no figure as agreeing.
   */
  periodRefusal: string | null;
};

class RowsRollback extends Error {}
const CANDIDATES_PER_ROW = 8;
const FAMILY_PREFIX = "^(uk-ghg|iea|ceda|ice|swc|nzi)-";
const CODE_SQL = `coalesce(f.legacy_original_id, regexp_replace(f.factor_id, '${FAMILY_PREFIX}', ''))`;
type FactorRow = { dataset_id: string; factor_id: string; label: string; activity_unit: string; rate: string; scopes: string[]; source_levels: string[] | null;
  code: string; source_system: string | null; legacy_db_id: string | null; dataset: string; year: number | null };
/** The previous system's own rate, to the factor's: the same number (a stored float's last digits aside). */
const sameRate = (a: number, b: number | null) => b !== null && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
const ofScope = (scope: V7ImportScope) => new Set(emissionCategoryTaxonomy.filter((category) => category.scope === scope).map((category) => category.code));

/** The library's view of categories: the rules, the variants and the pairs, read once — and a factor's claimed categories from them. */
async function categoryReader(db: Queryable, organisationId: string) {
  const registry = await listCategoryVariants(db);
  const rules = await listMembershipRules(db);
  const pairedCategories = await pairedCategoriesLookup(db, organisationId, registry);
  const parse = (factorId: string) => parseFactorId(factorId, registry);
  return {
    rules, suffixes: registry.map((variant) => variant.suffixCode), familyless: familylessCategories(rules),
    /** Each factor id's claimed categories (every category whose family names it). */
    claimed(factors: readonly MembershipFactor[]): Map<string, string[]> {
      const out = new Map<string, string[]>(factors.map((factor) => [factor.factorId, []]));
      for (const category of emissionCategoryTaxonomy) {
        const members = membersOfCategory({ categoryCode: category.code, rules, factors, parse, pairedCategories });
        for (const id of members ?? []) out.get(id)?.push(category.code);
      }
      return out;
    },
  };
}

/** The row's own categories: its category code where the previous system wrote one, else what the family rules make of its levels. */
function rowCategories(planned: PlannedRow | undefined, scope: V7ImportScope, rules: Parameters<typeof categoriesForLevels>[0]): string[] {
  if (!planned) return [];
  const codes = ofScope(scope);
  if (codes.has(planned.v7Scope)) return [planned.v7Scope];
  const levels = [planned.level1, planned.level2, planned.level3, planned.level4].filter((level): level is string => level !== null);
  return categoriesForLevels(rules, levels).filter((code) => codes.has(code));
}

/**
 * The rows, for a holder of `import.refresh` on the job (the refresh's own rule), read in a transaction that is always rolled back.
 */
export async function readV7ImportRows(pool: PoolLike, source: V7ImportRefreshSource, holder: CapabilityHolder, jobId: string,
  options: Pick<V7ImportRefreshOptions, "basePlan"> = {}): Promise<V7ImportRows> {
  let rows: V7ImportRows | null = null;
  try {
    await withTenantWrite(pool, holder.organisationId, async (db) => {
      await assertCapabilityOnClient(db, holder, "import.refresh", { jobId });
      rows = await buildRows(db, source, holder.organisationId, jobId, options.basePlan);
      throw new RowsRollback();
    });
  } catch (error) {
    if (!(error instanceof RowsRollback)) throw error;
  }
  return rows!;
}

async function buildRows(db: Queryable, source: V7ImportRefreshSource, org: string, jobId: string, basePlan: V7ImportRefreshOptions["basePlan"]): Promise<V7ImportRows> {
  const { mapping, read } = await buildV7ImportMapping(db, source, org, jobId, basePlan);
  const planned = new Map(read.rows.map((row) => [row.legacyDbId, row]));
  const library = await categoryReader(db, org);
  const summaryOf = new Map(read.summary.rows.map((row) => [row.legacyDbId, row]));
  const carryOf = new Map(read.resolved.rows.map((row) => [row.legacyDbId, row.carry]));

  // The rows a mapping is for: new or needs-mapping, still in the previous system.
  const needsMap = (row: V7ImportMappingRow) => (row.ownStatus === "new" || row.ownStatus === "needs-mapping") && planned.has(row.legacyDbId);
  const wanted = mapping.rows.filter(needsMap);
  const keysOf = new Map(wanted.map((row) => [row.legacyDbId, v7CodeKeys(planned.get(row.legacyDbId)!.migratedRecord.original_id, library.suffixes)]));
  // Fetched by the shorter key, so both steps of the ID match are in hand; which step a factor matches on is decided below.
  const prefixes = [...new Set([...keysOf.values()].map((keys) => keys.fallback ?? keys.core).filter((key): key is string => key !== null))];
  const lookupIds = [...new Set(wanted.map((row) => planned.get(row.legacyDbId)!.migratedRecord.factor_db_id).filter((id): id is string => typeof id === "string" && id !== ""))];
  const intended = wanted.filter((row) => row.intended.datasetId && row.intended.factorId);
  const factors = prefixes.length + lookupIds.length + intended.length === 0 ? [] : (await db.query<FactorRow>(
    `SELECT f.dataset_id, f.factor_id, f.label, f.activity_unit, f.kgco2e_per_unit::text AS rate, f.scopes, f.source_levels, ${CODE_SQL} AS code,
            f.source_system, f.legacy_db_id, d.name AS dataset, extract(year FROM d.valid_from)::int AS year
       FROM nzi_console.emission_factors f JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id, d.dataset_id) = (f.organisation_id, f.dataset_id)
      WHERE f.organisation_id = $1 AND f.active AND d.status = 'active'
        AND ((f.source_system = $2 AND f.legacy_db_id = ANY($3::text[]))
          OR EXISTS (SELECT 1 FROM unnest($4::text[]) c WHERE starts_with(lower(${CODE_SQL}), c))
          OR (f.dataset_id, f.factor_id) IN (SELECT * FROM unnest($5::text[], $6::text[])))
      ORDER BY f.label, d.name, f.factor_id`,
    [org, V7_IMPORT_SOURCE_SYSTEM, lookupIds, prefixes, intended.map((row) => row.intended.datasetId!), intended.map((row) => row.intended.factorId!)])).rows;
  const claimed = library.claimed(factors.map((factor) => ({ factorId: factor.factor_id, activityUnit: factor.activity_unit, sourceLevels: factor.source_levels ?? [] })));
  const factorKeys = new Map(factors.map((factor) => [`${factor.dataset_id}|${factor.factor_id}`, v7FactorKeys(factor.code, library.suffixes)]));
  // The job's reporting year (the year its datasets are chosen by): where the previous system's own factor is the anchor.
  const jobYear = (await db.query<{ year: number | null }>(
    `SELECT coalesce(reporting_year, extract(year FROM start_date)::int) AS year FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2`, [org, jobId])).rows[0]?.year ?? null;
  const v7CategoryOf = (row: V7ImportMappingRow) => v7CategoryCode(read.v7Categories[row.legacyDbId] ?? planned.get(row.legacyDbId)?.level2 ?? null, row.scope);

  // Each wanted row's candidates, judged; then whether each would save, in one check.
  const judged = new Map<string, V7ImportCandidate[]>();
  for (const row of wanted) {
    const plan = planned.get(row.legacyDbId)!;
    const record = plan.migratedRecord;
    const keys = keysOf.get(row.legacyDbId)!;
    const input: V7MatchRow = { scope: row.scope, quantity: record.qty, applyPct: v7ApplyPct(record.apply_pct), previousTco2e: row.previous.tco2e,
      categories: rowCategories(plan, row.scope, library.rules), v7Category: v7CategoryOf(row) };
    const keyOf = (factor: FactorRow) => factorKeys.get(`${factor.dataset_id}|${factor.factor_id}`)!;
    const isIdentity = (factor: FactorRow) => factor.source_system === V7_IMPORT_SOURCE_SYSTEM && factor.legacy_db_id !== null && factor.legacy_db_id === record.factor_db_id;
    // The ID, in order (§3): the core first; the unitless fallback only when the core finds nothing — never both.
    const byCore = factors.filter((factor) => keys.core !== null && keyOf(factor).core === keys.core);
    const byCode = byCore.length ? byCore : factors.filter((factor) => keys.fallback !== null && keyOf(factor).unitless === keys.fallback);
    const own = factors.filter((factor) => isIdentity(factor) || byCode.includes(factor)
      || (factor.dataset_id === row.intended.datasetId && factor.factor_id === row.intended.factorId));
    const year = jobYear ?? record.dataset?.year ?? null;
    judged.set(row.legacyDbId, own.map((factor): V7ImportCandidate => {
      const rate = Number(factor.rate);
      // The anchor (§1): the previous system's own factor — or its core code, for a variant row — in the job's year, at its own rate.
      const anchor = year !== null && factor.year === year && sameRate(rate, record.factor) && (isIdentity(factor) || byCore.includes(factor));
      const categories = claimed.get(factor.factor_id) ?? [];
      // The unit, by the rule bringing it in applies (v7UnitAgainstFactor): the same unit, or why it would be refused.
      const unit = v7UnitAgainstFactor(record.uom, factor.activity_unit);
      return {
        datasetId: factor.dataset_id, factorId: factor.factor_id, code: factor.code, label: factor.label, unit: factor.activity_unit, rate, dataset: factor.dataset,
        identity: isIdentity(factor), exactCode: record.original_id !== null && factor.code.toLowerCase() === record.original_id.trim().toLowerCase(),
        anchor, year: factor.year, scopes: factor.scopes, categories,
        match: v7MatchCandidate(input, { rate, scopes: factor.scopes, categories, sameUnit: unit.sameUnit, anchor }, library.familyless),
        unitRefusal: unit.refusal, invalid: null,
      };
    }));
  }
  const checks = [...judged].flatMap(([legacyDbId, candidates]) => candidates.filter((candidate) => candidate.match.categoryCode !== null).map((candidate) =>
    ({ key: `${legacyDbId}|${candidate.datasetId}|${candidate.factorId}`, scope: summaryOf.get(legacyDbId)!.scope,
      categoryCode: candidate.match.categoryCode!, datasetId: candidate.datasetId, factorId: candidate.factorId })));
  const invalid = await invalidV7ImportMappings(db, org, checks);
  for (const [legacyDbId, candidates] of judged) for (const candidate of candidates) {
    candidate.invalid = invalid.get(`${legacyDbId}|${candidate.datasetId}|${candidate.factorId}`)?.message ?? candidate.unitRefusal;
  }

  // The previous system's own counting per scope: a scope total it still counts beside activity rows of that scope counts twice.
  const isTotal = (row: V7ImportMappingRow) => V7_SCOPE_TOTAL_CODE.test(row.previous.factorCode ?? "");
  const activityCounted = new Set(mapping.rows.filter((row) => !isTotal(row) && row.ownStatus !== "withdrawn" && row.previous.enabled === true).map((row) => row.scope));

  const rows = mapping.rows.map((row): V7ImportRowsRow => {
    const summary = summaryOf.get(row.legacyDbId);
    const candidates = rankV7Candidates(judged.get(row.legacyDbId) ?? []).slice(0, CANDIDATES_PER_ROW);
    const total = isTotal(row);
    const retiring = total && (row.ownStatus === "withdrawn" || row.previous.enabled === false);
    const decided = row.resolution === "resolved" && row.decision?.kind === "map"
      ? (judged.get(row.legacyDbId) ?? []).find((candidate) => candidate.datasetId === row.decision!.datasetId && candidate.factorId === row.decision!.factorId) ?? null : null;
    const auto = v7AutoPick(candidates);
    const best = candidates.find((candidate) => !candidate.invalid && candidate.match.rightBasis && (candidate.match.verdict === "reproduces" || candidate.match.verdict === "close")) ?? null;
    // Switched off in the previous system (§2, ruled): mapped to its own factor — the anchor, else its lookup row — whatever the
    // figure says (it is never counted, so the figure decides nothing); a person finds one only when it has none that would save.
    const ownFactor = candidates.find((candidate) => candidate.anchor) ?? candidates.find((candidate) => candidate.identity) ?? null;
    const usable = (candidate: V7ImportCandidate | null) => candidate !== null && candidate.match.categoryCode !== null && !candidate.invalid ? candidate : null;
    let lane: V7ImportRowLane;
    let pick: V7ImportCandidate | null = null;
    // Why the row needs a person although its factor was found: bringing it in on that factor would be refused (its unit).
    let held: string | null = null;
    if (retiring) lane = "retiring";
    else if (row.ownStatus === "matched" || row.ownStatus === "changed") lane = "in-console";
    else if (row.resolution === "resolved" && decided?.unitRefusal) { lane = "unmatched"; held = decided.unitRefusal; }
    else if (row.resolution === "resolved") { lane = "accepted"; pick = decided; }
    else if (row.ownStatus === "withdrawn") lane = "confirm-off";
    else if (row.previous.enabled === false) { lane = "switched-off"; pick = usable(ownFactor); held = pick ? null : ownFactor?.unitRefusal ?? null; }
    else if (auto) { lane = "pre-accepted"; pick = auto; }
    else if (best) { lane = "suggested"; pick = best; }
    else { lane = "unmatched"; held = (ownFactor ?? candidates.find((candidate) => candidate.match.rightBasis))?.unitRefusal ?? null; }
    return { ...row, lane, held, applyPct: v7ApplyPct(planned.get(row.legacyDbId)?.migratedRecord.apply_pct ?? null),
      categories: rowCategories(planned.get(row.legacyDbId), row.scope, library.rules), v7Category: v7CategoryOf(row),
      pairGroup: summary?.pairGroup ?? null, carry: carryOf.get(row.legacyDbId) ?? null, candidates: needsMap(row) ? candidates : [], pick,
      totalStillCounted: total && !retiring && row.ownStatus !== "withdrawn" && activityCounted.has(row.scope) };
  });
  const { rows: _rows, ...rest } = mapping;
  const periodRefusal = v7ImportPeriodIssue(await readV7ImportPeriod(db, org, jobId))?.message ?? null;
  return { ...rest, rows, familyless: library.familyless, periodRefusal };
}

// ── The search ──────────────────────────────────────────────────────────────────────────────────────────────────

export type V7ImportFactorHit = {
  datasetId: string; factorId: string; code: string; label: string; unit: string; rate: number; dataset: string; scopes: string[];
  /** The categories whose family claims it. */
  categories: string[];
  /** Priced per the row's unit (the unit the modal names), as the re-ingest's own unit check reads it. */
  sameUnit: boolean;
  /** Why bringing the row in on it would be refused for its unit, or null (`v7UnitAgainstFactor`). */
  unitRefusal: string | null;
};

const SEARCH_LIMIT = 50;
const MAX_TOKENS = 8;

/**
 * The factor library, by any combination of words of the factor's ID, label, unit and dataset, in any order ("car petrol small
 * km"), active factors in active datasets. Every word must appear; a hit whose every word begins a word ranks first, then the
 * shorter label. Read-only; nothing of the row is sent but its unit.
 */
export async function searchV7ImportFactors(pool: PoolLike, holder: CapabilityHolder, input: { jobId: string; query: string; unit: string | null }):
  Promise<{ hits: V7ImportFactorHit[]; familyless: string[] }> {
  const tokens = [...new Set(input.query.toLowerCase().split(/\s+/).map((token) => token.trim()).filter((token) => token.length > 0))].slice(0, MAX_TOKENS);
  if (!tokens.length || tokens.some((token) => token.length > 60)) throw new CommandValidationError([{ field: "query", code: "INVALID", message: "Type a few words of the factor: its ID, what it is, its unit." }]);
  return withTenantRead(pool, holder.organisationId, async (db) => {
    await assertCapabilityOnClient(db, holder, "import.refresh", { jobId: input.jobId });
    const found = (await db.query<FactorRow>(
      `SELECT f.dataset_id, f.factor_id, f.label, f.activity_unit, f.kgco2e_per_unit::text AS rate, f.scopes, f.source_levels, ${CODE_SQL} AS code,
              f.source_system, f.legacy_db_id, d.name AS dataset, extract(year FROM d.valid_from)::int AS year
         FROM nzi_console.emission_factors f JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id, d.dataset_id) = (f.organisation_id, f.dataset_id)
        WHERE f.organisation_id = $1 AND f.active AND d.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM unnest($2::text[]) t
                           WHERE position(t IN lower(f.factor_id || ' ' || coalesce(f.legacy_original_id, '') || ' ' || f.label || ' ' || f.activity_unit || ' ' || d.name)) = 0)
        ORDER BY length(f.label), f.label, d.name, f.factor_id LIMIT 400`, [holder.organisationId, tokens])).rows;
    const escaped = tokens.map((token) => new RegExp(`(^|[^\\p{L}\\p{N}])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u"));
    const wordStart = (factor: FactorRow) => { const text = `${factor.factor_id} ${factor.code} ${factor.label} ${factor.activity_unit} ${factor.dataset}`.toLowerCase(); return escaped.every((pattern) => pattern.test(text)); };
    const ranked = found.map((factor, at) => ({ factor, at, starts: wordStart(factor) })).sort((a, b) => Number(b.starts) - Number(a.starts) || a.at - b.at).slice(0, SEARCH_LIMIT).map(({ factor }) => factor);
    const library = await categoryReader(db, holder.organisationId);
    const claimed = library.claimed(ranked.map((factor) => ({ factorId: factor.factor_id, activityUnit: factor.activity_unit, sourceLevels: factor.source_levels ?? [] })));
    return { familyless: library.familyless, hits: ranked.map((factor) => ({ datasetId: factor.dataset_id, factorId: factor.factor_id, code: factor.code, label: factor.label,
      unit: factor.activity_unit, rate: Number(factor.rate), dataset: factor.dataset, scopes: factor.scopes, categories: claimed.get(factor.factor_id) ?? [],
      ...(({ sameUnit, refusal }) => ({ sameUnit, unitRefusal: refusal }))(v7UnitAgainstFactor(input.unit, factor.activity_unit)) })) };
  });
}

// ── The accept ──────────────────────────────────────────────────────────────────────────────────────────────────

export type V7ImportRowsAcceptItem =
  | { kind: "map"; legacyDbId: string; categoryCode: string; datasetId: string; factorId: string; expectedDecisionId: string | null }
  | { kind: "withdraw"; legacyDbId: string; expectedDecisionId: string | null }
  | { kind: "carry"; legacyDbId: string };
export type V7ImportRowsAcceptInput = { jobId: string; items: V7ImportRowsAcceptItem[] };
export type V7ImportRowsAcceptResult = {
  jobId: string;
  /** Decisions written, and the audit event of each. */
  written: Array<{ legacyDbId: string; kind: V7ImportRowsAcceptItem["kind"]; decisionId: string | null; auditEventId: string }>;
  /** Already so: nothing to write. */
  unchanged: string[];
  /** Refused by the decision command — by code, never by figure; the rest still went ahead. */
  refused: Array<{ legacyDbId: string; kind: V7ImportRowsAcceptItem["kind"]; codes: string[]; message: string }>;
};

export const V7_IMPORT_ROWS_ACCEPT_MAX = 1000;
const ITEM_KEYS: Record<V7ImportRowsAcceptItem["kind"], readonly string[]> = {
  map: ["kind", "legacyDbId", "categoryCode", "datasetId", "factorId", "expectedDecisionId"],
  withdraw: ["kind", "legacyDbId", "expectedDecisionId"],
  carry: ["kind", "legacyDbId"],
};

/** The request's shape: closed, as a decision is — ids, codes and kinds only. Each item's meaning is the decision command's to check. */
export function v7ImportRowsAcceptIssues(input: unknown): Array<{ field: string; code: string; message: string }> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return [{ field: "input", code: "INVALID", message: "Name the job and the rows to accept." }];
  const body = input as Record<string, unknown>;
  const extra = Object.keys(body).filter((key) => key !== "jobId" && key !== "items");
  if (extra.length) return [{ field: "input", code: "UNKNOWN_FIELD", message: `An accept carries the job and its items only; it has ${extra.slice(0, 5).join(", ")}.` }];
  if (typeof body.jobId !== "string" || !body.jobId.trim()) return [{ field: "jobId", code: "REQUIRED", message: "Name the job." }];
  if (!Array.isArray(body.items) || body.items.length === 0) return [{ field: "items", code: "REQUIRED", message: "Name at least one row to accept." }];
  if (body.items.length > V7_IMPORT_ROWS_ACCEPT_MAX) return [{ field: "items", code: "TOO_MANY", message: `At most ${V7_IMPORT_ROWS_ACCEPT_MAX} rows in one accept.` }];
  for (const [at, item] of body.items.entries()) {
    const field = `items[${at}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [{ field, code: "INVALID", message: "Each item is one row's decision." }];
    const entry = item as Record<string, unknown>;
    const allowed = ITEM_KEYS[entry.kind as V7ImportRowsAcceptItem["kind"]];
    if (!allowed) return [{ field, code: "INVALID", message: "An item maps a row, confirms its withdrawal, or carries its pair." }];
    const unknown = Object.keys(entry).filter((key) => !allowed.includes(key));
    if (unknown.length) return [{ field, code: "UNKNOWN_FIELD", message: `An item carries ids, codes and its kind only; it has ${unknown.slice(0, 5).join(", ")}.` }];
    if (typeof entry.legacyDbId !== "string" || !/^(source:)?[0-9A-Za-z_-]{1,64}$/.test(entry.legacyDbId)) return [{ field, code: "INVALID", message: "The record id is an id of the previous system." }];
  }
  return [];
}

/**
 * import.decision.set, once per item, in order: the same command and checks as one row's control, each under its own key
 * (the request's key and the item's place), so a retried request replays what it already wrote and writes the rest. A refusal of
 * one item is reported and the rest go ahead; a refusal of the caller stops the request before anything is written.
 */
export async function acceptV7ImportRows(pool: PoolLike, input: V7ImportRowsAcceptInput, context: CommandContext): Promise<V7ImportRowsAcceptResult> {
  const issues = v7ImportRowsAcceptIssues(input);
  if (issues.length) throw new CommandValidationError(issues);
  const result: V7ImportRowsAcceptResult = { jobId: input.jobId, written: [], unchanged: [], refused: [] };
  for (const [at, item] of input.items.entries()) {
    const decision: CommandInputMap["import.decision.set"] = item.kind === "map"
      ? { jobId: input.jobId, sourceSystem: V7_IMPORT_SOURCE_SYSTEM, legacyDbId: item.legacyDbId, kind: "map" as const, categoryCode: item.categoryCode, datasetId: item.datasetId,
        factorId: item.factorId, expectedDecisionId: item.expectedDecisionId }
      : item.kind === "withdraw"
        ? { jobId: input.jobId, sourceSystem: V7_IMPORT_SOURCE_SYSTEM, legacyDbId: item.legacyDbId, kind: "withdraw" as const, expectedDecisionId: item.expectedDecisionId }
        : { jobId: input.jobId, sourceSystem: V7_IMPORT_SOURCE_SYSTEM, legacyDbId: item.legacyDbId, kind: "carry" as const, carryOption: "A" as const };
    try {
      const outcome = await setV7ImportDecision(pool, decision, { ...context, idempotencyKey: `${context.idempotencyKey}:${at}:${item.kind}:${item.legacyDbId}` });
      result.written.push({ legacyDbId: item.legacyDbId, kind: item.kind, decisionId: outcome.data.decisionId, auditEventId: outcome.auditEventId });
    } catch (error) {
      if (error instanceof AuthorizationError) throw error;
      if (!(error instanceof CommandValidationError)) throw error;
      const codes = error.issues.map((issue) => issue.code);
      if (codes.length && codes.every((code) => code === "UNCHANGED" || code === "NOTHING_TO_RESOLVE")) { result.unchanged.push(item.legacyDbId); continue; }
      result.refused.push({ legacyDbId: item.legacyDbId, kind: item.kind, codes, message: error.issues.map((issue) => issue.message).join(" ") });
    }
  }
  return result;
}
