import {
  resolveFactorForEntry,
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

export async function applyDeclarativeResolution(
  db: Queryable,
  organisationId: string,
  jobId: string,
  input: ScopeRowWriteFields,
  categoryCode: string | null,
  actorId: string,
): Promise<DeclarativeResolution> {
  if (!categoryCode) return { kind: "not-enabled" };
  const switched = await db.query<{ declarative_resolution_enabled: boolean }>(
    `SELECT declarative_resolution_enabled FROM nzi_console.input_spec_categories WHERE category_code = $1`, [categoryCode]);
  if (!switched.rows[0]?.declarative_resolution_enabled) return { kind: "not-enabled" };

  // The job's selected datasets are the only factors a row may use; the resolver is handed exactly those.
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
  const attributes = input.assertedVehicleAttributes ?? null;
  const outcome = resolveFactorForEntry({
    rules,
    specGhgCategory: input.scope,
    entry: entryFor(input, attributes, [...rules, ...Object.values(rulesByCategory).flat()]),
    available: factors.map((factor) => ({ factorId: factor.factorId, scopes: factor.scopes, unit: factor.unit })),
    registry: await listCategoryVariants(db),
    enrichment: attributes ? { dvla: { fuel: attributes.fuel, class: attributes.vehicleClass } } : undefined,
    rulesByCategory,
    reconcileUnit: reconcileUnitForMapping,
  });

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
  const deliberate = (input.factorSource ?? "dataset") === "client" || input.overrideTco2e != null;

  if (outcome.kind !== "resolved") {
    return { kind: "apply", factor: pick(input), provenance: { declarativeResolution: { ...trail, decision: "search" } } };
  }

  const declared = declaredFactor(outcome, factors);
  if (!declared) {
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
  if (deliberate) {
    return { kind: "apply", factor: pick(input),
      provenance: { declarativeResolution: { ...trail, decision: "override", deviatedBy: actorId, deviatedFrom: declared.factorId } } };
  }
  return { kind: "refuse", field: "factorId", code: "FACTOR_NOT_DECLARED",
    message: `This category resolves to '${declared.label}' (${declared.factorId}) for this entry. Use that factor, `
      + "or record a deliberate override with a reason." };
}

/** The factor fields exactly as the caller sent them. */
const pick = (input: ScopeRowWriteFields): ResolvedFactorFields => ({
  datasetId: input.datasetId, factorId: input.factorId, factorVersion: input.factorVersion, factorLabel: input.factorLabel,
});

/** The resolver reads captured fields by key; a lookup's key field holds a marker, so the plate never enters. */
function entryFor(input: ScopeRowWriteFields, attributes: AssertedVehicleAttributes | null, rules: readonly FactorRule[]) {
  const entry: Record<string, string | null> = { unit: input.unit ?? null, supplySource: input.supplySource ?? null };
  if (attributes) {
    for (const rule of rules) if (rule.kind === "enriched") entry[rule.enrichmentKeyField] = ASSERTED_AT_CAPTURE;
  }
  return entry;
}

function declaredFactor(outcome: Extract<MappingOutcome, { kind: "resolved" }>, factors: readonly AvailableFactor[]) {
  const carriers = factors.filter((factor) => factor.factorId === outcome.factorId);
  return carriers.length === 1 ? carriers[0]! : null;
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
