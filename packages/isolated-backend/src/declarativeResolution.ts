import {
  parseFactorId, resolveFactorForEntry, variantFactorId,
  type AssertedVehicleAttributes, type FactorRule, type MappingOutcome, type ScopeRowWriteFields,
} from "@nzi/contracts";
import type { Queryable } from "./postgres";
import { listCategoryVariants } from "./factorCategoryVariants";
import { companionRulesFor, factorRulesFor, listFactorRules } from "./inputSpecFactorRules";
import { reconcileUnitForMapping } from "./unitCompatibility";

/**
 * The write path's use of the declarative resolver (Stop 2) — one helper, inside the governing command's
 * transaction, in the shape `reaggregateGroupRollup` set: no second write path, no separate commit.
 *
 * ## Called by, and only by
 *
 * `createScopeRow` and `updateScopeRow`. The other three places a factor lands on a scope row — portal
 * acceptance, emission-source sync, year roll-forward — do not call it (NZC-160 F4, H7), and a reachability test
 * says so. The characterisation covers three of those five paths; this helper is wired into two of them.
 *
 * ## What it decides, for a category that is switched on (0120)
 *
 * The resolver's answer and the caller's factor are reconciled by the F1 rule:
 *
 *   - **filled** — the caller sent no factor and the category resolves one: the declared factor is written.
 *   - **matched** — the caller sent the declared factor: accepted.
 *   - **refused** — the caller sent a different factor: the write is refused, naming the declared one. Never
 *     silently replaced, never silently accepted. The same edit that picks a valid factor goes through, so an
 *     existing row holding a bad one is corrected by editing it (F2), not locked.
 *   - **override** — a deliberate override or client factor may differ from the declared one, which is what it
 *     is for — but it must still be a factor the row may carry, and it is recorded as a deviation with the actor.
 *   - **search** — the category declares nothing for this entry: the caller's factor stands, as today, subject
 *     to the same validity gate.
 *
 * Deviation from the resolver: allowed and recorded. Deviation from validity: never.
 *
 * ## For a category that is switched off
 *
 * Nothing. The input comes back untouched and no provenance is added, so a row in an un-enabled category is
 * byte-for-byte what it was before this existed.
 */

export type ResolvedFactorFields = Pick<ScopeRowWriteFields, "datasetId" | "factorId" | "factorVersion" | "factorLabel">;

export type DeclarativeResolution =
  | { kind: "not-enabled" }
  | { kind: "apply"; factor: ResolvedFactorFields; provenance: Record<string, unknown> }
  | { kind: "refuse"; field: string; code: string; message: string };

type AvailableFactor = { factorId: string; datasetId: string; datasetVersion: string; label: string; unit: string; scopes: string[] };

/** A lookup's attributes as the resolver matches them. The key field gets a marker, never a registration. */
const ASSERTED_AT_CAPTURE = "(asserted at capture)";

type Declared = {
  outcome: MappingOutcome;
  factors: AvailableFactor[];
  /** The one factor the resolved id names, or null when nothing resolved or it is ambiguous across datasets. */
  declared: AvailableFactor | null;
  ambiguous: boolean;
  attributes: AssertedVehicleAttributes | null;
};

/** The entry fields resolution reads — what the write sends, and what the form's preview sends. */
export type ResolutionEntry = Pick<ScopeRowWriteFields, "scope" | "unit" | "supplySource" | "assertedVehicleAttributes">;

/**
 * The resolver's answer for one entry, or null when the category is switched off.
 *
 * One function for the write and for the form's preview, so the two cannot come to different answers: the
 * preview shows what the write will do, and the write re-resolves regardless (it never trusts the preview).
 */
async function resolveDeclared(db: Queryable, organisationId: string, jobId: string, entry: ResolutionEntry, categoryCode: string | null): Promise<Declared | null> {
  if (!categoryCode) return null;
  const switched = await db.query<{ declarative_resolution_enabled: boolean }>(
    `SELECT declarative_resolution_enabled FROM nzi_console.input_spec_categories WHERE category_code = $1`, [categoryCode]);
  if (!switched.rows[0]?.declarative_resolution_enabled) return null;

  // The job's selected datasets are the only factors a row may use; the resolver is handed exactly those. Which
  // factor is "the grid factor" is the declared rule's to say, against whatever datasets this job selected —
  // nothing here names one, so a regional or period grid is a rule and a dataset, not a code change.
  const factors = (await db.query<{ factor_id: string; dataset_id: string; version: string; label: string; activity_unit: string; scopes: string[] }>(
    `SELECT f.factor_id, f.dataset_id, d.version, f.label, f.activity_unit, f.scopes
       FROM nzi_console.job_dataset_selections s
       JOIN nzi_console.emission_factors f ON (f.organisation_id, f.dataset_id) = (s.organisation_id, s.dataset_id)
       JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id, d.dataset_id) = (f.organisation_id, f.dataset_id)
      WHERE s.organisation_id = $1 AND s.job_id = $2 AND f.active`, [organisationId, jobId])).rows
    .map((row): AvailableFactor => ({ factorId: row.factor_id, datasetId: row.dataset_id, datasetVersion: row.version,
      label: row.label, unit: row.activity_unit, scopes: row.scopes }));

  const rules = await factorRulesFor(db, categoryCode);
  const rulesByCategory: Record<string, readonly FactorRule[]> = Object.fromEntries(await listFactorRules(db));
  const attributes = entry.assertedVehicleAttributes ?? null;
  const outcome = resolveFactorForEntry({
    rules,
    specGhgCategory: entry.scope,
    entry: entryFor(entry, attributes, [...rules, ...Object.values(rulesByCategory).flat()]),
    available: factors.map((factor) => ({ factorId: factor.factorId, scopes: factor.scopes, unit: factor.unit })),
    registry: await listCategoryVariants(db),
    enrichment: attributes ? { dvla: { fuel: attributes.fuel, class: attributes.vehicleClass } } : undefined,
    rulesByCategory,
    reconcileUnit: reconcileUnitForMapping,
  });
  const carriers = outcome.kind === "resolved" ? factors.filter((factor) => factor.factorId === outcome.factorId) : [];
  return { outcome, factors, declared: carriers.length === 1 ? carriers[0]! : null, ambiguous: carriers.length > 1, attributes };
}

/**
 * What the form's preview is told: whether the category is on, and if so what it declares for this entry — and,
 * whatever the switch, which factors this category refuses as the base of its own variant (Stop 2c).
 */
export type DeclaredFactorPreview =
  | { enabled: false; excludedFactorIds: string[] }
  | { enabled: true; declared: { datasetId: string; factorId: string; label: string; unit: string; version: string } | null; reason: string | null; excludedFactorIds: string[] };

/**
 * The factors a variant category refuses, because the category's own variant of each is on offer (Stop 2c).
 *
 * Business travel reuses the vehicle flow and files what it finds under `-b`; commuting under `-c` (NZC-158). A
 * base factor picked by hand in either — `diesel-demo` in business travel — is the Scope 1 figure filed under Scope
 * 3: the D1 leak on the manual path. Scope tags do not catch it, because the base is tagged `{1,3}`. So the rule is
 * the precise one: a factor is refused in a category that files under a suffix when that category's variant of it
 * is among the job's factors. Where no variant exists nothing is refused, so the category is never left with
 * nothing to pick — the dual-tagged per-distance factors stay open until distance-priced variants exist.
 *
 * Applies whether or not the category resolves declaratively: this is what a variant category may carry, not a
 * decision about resolution. The write refuses these; the form's pick list leaves them out.
 */
export async function variantBasesRefused(db: Queryable, organisationId: string, jobId: string, categoryCode: string | null)
  : Promise<Array<{ baseFactorId: string; variantFactorId: string }>> {
  if (!categoryCode) return [];
  const subFlows = (await factorRulesFor(db, categoryCode)).filter((rule) => rule.kind === "sub-flow");
  if (subFlows.length === 0) return [];
  const registry = await listCategoryVariants(db);
  const offered = new Set((await db.query<{ factor_id: string }>(
    `SELECT f.factor_id FROM nzi_console.job_dataset_selections s
       JOIN nzi_console.emission_factors f ON (f.organisation_id, f.dataset_id) = (s.organisation_id, s.dataset_id)
      WHERE s.organisation_id = $1 AND s.job_id = $2 AND f.active`, [organisationId, jobId])).rows.map((row) => row.factor_id));
  const refused: Array<{ baseFactorId: string; variantFactorId: string }> = [];
  for (const rule of subFlows) {
    if (rule.kind !== "sub-flow") continue;
    const variant = registry.find((entry) => entry.suffixCode === rule.suffixCode && entry.status === "active");
    if (!variant) continue;
    for (const factorId of offered) {
      if (parseFactorId(factorId, registry).base !== factorId) continue; // already a variant of something
      const own = variantFactorId(factorId, variant);
      if (offered.has(own)) refused.push({ baseFactorId: factorId, variantFactorId: own });
    }
  }
  return refused;
}

/** Why the sent factor is the base of this category's own variant, or null (Stop 2c). */
export async function variantBaseRefusal(db: Queryable, organisationId: string, jobId: string, input: ScopeRowWriteFields, categoryCode: string | null)
  : Promise<string | null> {
  const sent = input.factorId?.trim();
  if (!sent || (input.factorSource ?? "dataset") !== "dataset") return null;
  const hit = (await variantBasesRefused(db, organisationId, jobId, categoryCode)).find((pair) => pair.baseFactorId === sent);
  return hit
    ? `'${sent}' is the base factor this category files as '${hit.variantFactorId}'. The base belongs to the scope it was measured for; use '${hit.variantFactorId}'.`
    : null;
}

/**
 * The declared factor for an entry as it stands, for the capture form (Stop 2b, H3).
 *
 * Read-only. The CRM shows this factor, and its unit, before a quantity is typed — the unit comes from the
 * factor and is never rewritten from one the user entered. Keyed on the category the form sends, which is only
 * a preview: the write resolves again from the row's own category, and F1 refuses anything that disagrees.
 */
export async function previewDeclaredFactor(db: Queryable, organisationId: string, jobId: string, entry: ResolutionEntry, categoryCode: string | null): Promise<DeclaredFactorPreview> {
  const resolved = await resolveDeclared(db, organisationId, jobId, entry, categoryCode);
  const excludedFactorIds = (await variantBasesRefused(db, organisationId, jobId, categoryCode)).map((pair) => pair.baseFactorId);
  if (!resolved) return { enabled: false, excludedFactorIds };
  const { declared, outcome } = resolved;
  return {
    enabled: true,
    excludedFactorIds,
    declared: declared ? { datasetId: declared.datasetId, factorId: declared.factorId, label: declared.label, unit: declared.unit, version: declared.datasetVersion } : null,
    reason: declared ? null : outcome.kind === "free-search" ? outcome.reason : "the declared factor is carried by more than one selected dataset",
  };
}

export async function applyDeclarativeResolution(
  db: Queryable,
  organisationId: string,
  jobId: string,
  input: ScopeRowWriteFields,
  categoryCode: string | null,
  actorId: string,
): Promise<DeclarativeResolution> {
  const resolved = await resolveDeclared(db, organisationId, jobId, input, categoryCode);
  if (!resolved || !categoryCode) return { kind: "not-enabled" };
  const { outcome, factors, declared, ambiguous, attributes } = resolved;

  const companionBases = new Set((await companionRulesFor(db, categoryCode)).map((rule) => rule.factorBase));
  const validity = await validityOf(db, organisationId, input, categoryCode, factors, companionBases);
  const trail = {
    categoryCode,
    outcome: outcome.kind,
    ruleKey: outcome.kind === "resolved" ? outcome.rule.ruleKey : null,
    declaredFactorId: outcome.kind === "resolved" ? outcome.factorId : null,
    reason: outcome.kind === "free-search" ? outcome.reason : null,
    declined: outcome.declined,
    // F3: what the lookup said, and that it was asserted by whoever captured the entry rather than re-checked.
    assertedVehicleAttributes: attributes ? { ...attributes, trust: "asserted-at-capture" } : null,
  };

  if (validity) return { kind: "refuse", field: "factorId", code: "FACTOR_NOT_VALID_FOR_ROW", message: validity };

  const sent = input.factorId?.trim() || null;
  const factorChoiceReason = input.factorOverrideReason?.trim() || null;
  const overrideKind = (input.factorSource ?? "dataset") === "client" ? "client-factor"
    : input.overrideTco2e != null ? "emissions-override"
      : factorChoiceReason ? "factor-choice" : null;

  if (outcome.kind !== "resolved") {
    return { kind: "apply", factor: pick(input), provenance: { declarativeResolution: { ...trail, decision: "search" } } };
  }
  if (ambiguous || !declared) {
    // The same factor id in two selected datasets: which one is meant is not something to guess.
    return { kind: "refuse", field: "factorId", code: "DECLARED_FACTOR_AMBIGUOUS",
      message: `'${outcome.factorId}' is carried by more than one selected dataset, so which one is declared cannot be settled here.` };
  }
  if (!sent) {
    return { kind: "apply",
      factor: { datasetId: declared.datasetId, factorId: declared.factorId, factorVersion: declared.datasetVersion, factorLabel: declared.label },
      provenance: { declarativeResolution: { ...trail, decision: "filled" } } };
  }
  if (sent === declared.factorId && (input.datasetId ?? null) === declared.datasetId) {
    return { kind: "apply", factor: pick(input), provenance: { declarativeResolution: { ...trail, decision: "matched" } } };
  }
  if (overrideKind) {
    return { kind: "apply", factor: pick(input),
      provenance: { declarativeResolution: { ...trail, decision: "override", overrideKind,
        overrideReason: overrideKind === "factor-choice" ? factorChoiceReason : overrideKind === "emissions-override" ? input.overrideReason?.trim() ?? null : null,
        deviatedBy: actorId, deviatedFrom: declared.factorId } } };
  }
  return { kind: "refuse", field: "factorId", code: "FACTOR_NOT_DECLARED",
    message: `This category resolves to '${declared.label}' (${declared.factorId}) for this entry. Use that factor, `
      + "or give a reason for choosing a different one." };
}

/** The factor fields exactly as the caller sent them. */
const pick = (input: ScopeRowWriteFields): ResolvedFactorFields => ({
  datasetId: input.datasetId, factorId: input.factorId, factorVersion: input.factorVersion, factorLabel: input.factorLabel,
});

/** The resolver reads captured fields by key; a lookup's key field holds a marker, so the plate never enters. */
function entryFor(input: ResolutionEntry, attributes: AssertedVehicleAttributes | null, rules: readonly FactorRule[]) {
  const entry: Record<string, string | null> = { unit: input.unit ?? null, supplySource: input.supplySource ?? null };
  if (attributes) {
    for (const rule of rules) if (rule.kind === "enriched") entry[rule.enrichmentKeyField] = ASSERTED_AT_CAPTURE;
  }
  return entry;
}


/**
 * Why the caller's factor may not be this row's primary, or null when it may (the F1 validity gate).
 *
 * Applies to every factor in an enabled category, overrides and client factors included: an override may
 * deviate from the declared factor, never from what the row may carry. The same three clauses H1 applies to
 * the portal — the factor is active in a selected dataset, its scopes include the row's scope root, and it
 * is not a companion declared for this category.
 */
async function validityOf(
  db: Queryable, organisationId: string, input: ScopeRowWriteFields, categoryCode: string,
  factors: readonly AvailableFactor[], companionBases: ReadonlySet<string>,
): Promise<string | null> {
  const sent = input.factorId?.trim();
  if (!sent) return null;
  const root = input.scope.split(".")[0]!;

  if ((input.factorSource ?? "dataset") === "client") {
    const client = await db.query<{ scope: string }>(
      `SELECT scope FROM nzi_console.client_factors WHERE organisation_id = $1 AND client_factor_id = $2`,
      [organisationId, input.clientFactorId ?? ""]);
    const scope = client.rows[0]?.scope;
    if (!scope) return "The client factor is not available to this row.";
    return scope.split(".")[0] === root ? null
      : `The client factor is a Scope ${scope.split(".")[0]} factor, so it cannot be this Scope ${root} row's.`;
  }

  const factor = factors.find((candidate) => candidate.factorId === sent && candidate.datasetId === (input.datasetId ?? null));
  if (!factor) return `'${sent}' is not an active factor in a dataset selected for this job.`;
  if (!factor.scopes.includes(root)) return `'${factor.label}' is not a Scope ${root} factor, so it cannot be this row's.`;
  if (companionBases.has(factor.factorId)) {
    return `'${factor.label}' is a companion factor of ${categoryCode}: it belongs on its own row beside this one, never as this row's primary.`;
  }
  return null;
}
