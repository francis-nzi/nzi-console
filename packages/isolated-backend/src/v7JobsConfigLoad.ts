import { randomUUID } from "node:crypto";
import { JOB_TYPE_FAMILIES, MILESTONE_KINDS, type JobTypeFamily, type MilestoneKind } from "@nzi/contracts";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { familyByV7NameRule, IMPORT_ACTOR, SOURCE_SYSTEM } from "./v7ClientImport";
import type { V7Row, V7Table } from "./v7ClientExtract";

/**
 * The v7 jobs-configuration import (admin Phase C4, `load:v7-jobs-config`; ruled plan `admin-phaseC-plan.md` §4.2):
 * v7's VAT rates, milestone templates and their items, job types and job file types → 0139's typed tables,
 * reconciled onto what the console already holds.
 *
 * **Reconcile, per entity** — for each v7 row:
 * 1. **its v7 identity** (`source_system`, `legacy_db_id`) — a row this import made or stamped before;
 * 2. else **its natural key**, among rows with no v7 identity yet: a file type by its key (the two system types 0139
 *    provisioned), a VAT rate by its rate (and name), a template or a job type by its normalised name — stamped with
 *    the v7 identity from then on;
 * 3. else **inserted**.
 * Every row it touches records `legacy_values`, what it was loaded as. **Seeded or added-here rows v7 lacks are
 * reported, never archived.** Nothing is deleted.
 *
 * **Re-runs (R4)** — v7 unchanged since → left alone; v7 changed and the row is still as an import wrote it → v7 wins;
 * v7 changed **and** the row was edited here since → refused and reported, never silently.
 *
 * **One default (Q6)** — v7 with more than one default VAT rate, or template, or an inactive default, is **refused**
 * for that entity: nothing of it is written until v7 is put right, never guessed. None is reported. A default the
 * console chose itself is never displaced; one an import set moves with v7.
 *
 * **Template items → kinds, as v7 computes them** — ordered by `sort_order` then id, the **first three** are data
 * collection, first draft and final report (`api/job_management_routes.py:1286–1308`); a two-item template has no
 * final report, as in v7. Items beyond the third are undated checklist ticks: not carried (Q5), reported with how
 * many jobs ticked them.
 *
 * **One transaction, a savepoint per entity**, in dependency order (VAT → templates → job types → file types): an entity
 * that fails writes nothing of itself and the rest go ahead, and a later entity sees the earlier ones — job types link
 * the VAT rates loaded before them. A dry run is the whole load, rolled back.
 */

export const JOBS_CONFIG_RUN_PREFIX = "v7-jobs-config-";
/** The tables this load reads. The extract it runs on also carries `jobs` and `job_plan`, for C5. */
export const V7_JOBS_CONFIG_TABLES: readonly V7Table[] = [
  "vat_rates_lookup", "milestone_templates", "milestone_template_items", "job_template_milestone_completions", "job_types", "job_file_types_lookup",
];

const text = (value: string | null | undefined) => { const trimmed = value?.trim(); return trimmed ? trimmed : null; };
const collapse = (value: string) => value.trim().replace(/\s+/g, " ");
export const normaliseName = (value: string) => collapse(value).toLowerCase();
const flag = (value: string | null | undefined): boolean | null => {
  const v = value?.trim().toLowerCase();
  return v === "t" || v === "true" || v === "1" ? true : v === "f" || v === "false" || v === "0" ? false : null;
};
/** A number held to two places, or undefined when it is not one (a blank is null). */
const amount = (value: string | null | undefined, max: number): number | null | undefined => {
  const raw = text(value);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= max && Math.abs(Math.round(parsed * 100) - parsed * 100) < 1e-6 ? Math.round(parsed * 100) / 100 : undefined;
};
const whole = (value: string | null | undefined): number | null | undefined => {
  const raw = text(value);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : undefined;
};
const byId = (key: string) => (a: V7Row, b: V7Row) => Number(a[key]) - Number(b[key]) || String(a[key]).localeCompare(String(b[key]));

// ── The plan (pure) ────────────────────────────────────────────────────────────────────────────────────────────

export type Skipped = { table: V7Table; legacyDbId: string; reason: string };

export type PlannedVatRate = { legacyDbId: string; name: string; ratePct: number; isDefault: boolean; active: boolean; legacyValues: Record<string, unknown> };
export type PlannedTemplateItem = { legacyDbId: string; kind: MilestoneKind; label: string; daysOffset: number; legacyValues: Record<string, unknown> };
export type PlannedTemplate = {
  legacyDbId: string; name: string; description: string | null; isDefault: boolean; active: boolean; items: PlannedTemplateItem[];
  /** Items beyond the third — undated in v7, not carried (Q5). */
  extras: { items: string[]; jobsTicked: number };
  legacyValues: Record<string, unknown>;
};
export type PlannedJobType = {
  legacyDbId: string; name: string; family: JobTypeFamily; familyFrom: "job_family" | "job_group" | "name rule";
  description: string | null; defaultPriceExVat: number | null; estimatedHours: number | null; vatLegacyId: string | null; active: boolean;
  legacyValues: Record<string, unknown>;
};
export type PlannedFileType = {
  legacyDbId: string; key: string; displayName: string; folder: string; sortOrder: number; active: boolean; legacyValues: Record<string, unknown>;
};
export type JobsConfigPlan = {
  vatRates: { values: PlannedVatRate[]; refused: string | null };
  templates: { values: PlannedTemplate[]; refused: string | null; noDefault: boolean };
  jobTypes: { values: PlannedJobType[] };
  fileTypes: { values: PlannedFileType[] };
  skipped: Skipped[];
};

/** One default at most, and it active — else the entity is refused whole (Q6: never guessed). */
function defaultRefusal(what: string, values: ReadonlyArray<{ name: string; isDefault: boolean; active: boolean }>): string | null {
  const defaults = values.filter((value) => value.isDefault);
  if (defaults.length > 1) return `v7 has ${defaults.length} default ${what}s (${defaults.map((value) => value.name).join(", ")}). Nothing of the ${what}s is written until v7 has one; it is never guessed.`;
  if (defaults[0] && !defaults[0].active) return `v7's default ${what} "${defaults[0].name}" is inactive. A default is always active here; nothing of the ${what}s is written until v7 is put right.`;
  return null;
}

export function planV7JobsConfig(extract: Partial<Record<V7Table, readonly V7Row[]>>): JobsConfigPlan {
  const skipped: Skipped[] = [];
  const skip = (table: V7Table, legacyDbId: string | null, reason: string) => skipped.push({ table, legacyDbId: legacyDbId ?? "(blank)", reason });

  // VAT rates
  const vatRates: PlannedVatRate[] = [];
  const vatNames = new Map<string, string>();
  for (const row of [...(extract.vat_rates_lookup ?? [])].sort(byId("vat_rate_id"))) {
    const legacyDbId = text(row.vat_rate_id);
    if (!legacyDbId) { skip("vat_rates_lookup", null, "a row with no id"); continue; }
    const name = text(row.name);
    if (!name) { skip("vat_rates_lookup", legacyDbId, "a rate with no name"); continue; }
    const ratePct = amount(row.rate_pct, 100);
    if (ratePct === undefined || ratePct === null) { skip("vat_rates_lookup", legacyDbId, "a rate that is not a percentage from 0 to 100, to two places"); continue; }
    const clash = vatNames.get(normaliseName(name));
    if (clash) { skip("vat_rates_lookup", legacyDbId, `the same name as v7 rate ${clash}`); continue; }
    vatNames.set(normaliseName(name), legacyDbId);
    const isDefault = flag(row.is_default) ?? false;
    const isActive = flag(row.is_active);
    vatRates.push({ legacyDbId, name: collapse(name), ratePct, isDefault, active: isActive ?? true,
      legacyValues: { name, ratePct, isDefault, isActive } });
  }

  // Milestone templates and their items
  const ticks = new Map<string, Set<string>>(); // item id → jobs that ticked it
  for (const row of extract.job_template_milestone_completions ?? []) {
    const item = text(row.item_id), job = text(row.job_id);
    if (item && job && (flag(row.is_complete) ?? true)) ticks.set(item, new Set([...(ticks.get(item) ?? []), job]));
  }
  const itemsOf = new Map<string, V7Row[]>();
  for (const row of extract.milestone_template_items ?? []) {
    const template = text(row.template_id);
    if (template) itemsOf.set(template, [...(itemsOf.get(template) ?? []), row]);
  }
  const templates: PlannedTemplate[] = [];
  const templateNames = new Map<string, string>();
  const templateIds = new Set<string>();
  for (const row of [...(extract.milestone_templates ?? [])].sort(byId("template_id"))) {
    const legacyDbId = text(row.template_id);
    if (!legacyDbId) { skip("milestone_templates", null, "a row with no id"); continue; }
    templateIds.add(legacyDbId);
    const name = text(row.template_name);
    if (!name) { skip("milestone_templates", legacyDbId, "a template with no name"); continue; }
    const clash = templateNames.get(normaliseName(name));
    if (clash) { skip("milestone_templates", legacyDbId, `the same name as v7 template ${clash}`); continue; }
    // v7's own order: sort_order (its column defaults to 0), then id.
    const ordered = [...(itemsOf.get(legacyDbId) ?? [])].sort((a, b) =>
      (whole(a.sort_order) ?? 0) - (whole(b.sort_order) ?? 0) || byId("item_id")(a, b));
    if (ordered.length === 0) { skip("milestone_templates", legacyDbId, "a template with no milestones — v7 dates nothing from it"); continue; }
    const items: PlannedTemplateItem[] = [];
    let bad: string | null = null;
    for (const [index, item] of ordered.slice(0, 3).entries()) {
      const label = text(item.milestone_name);
      const daysOffset = whole(item.days_offset);
      if (!label) { bad = `item ${item.item_id} has no name`; break; }
      if (daysOffset === null || daysOffset === undefined || daysOffset < 0 || daysOffset > 3650) { bad = `item ${item.item_id}'s offset is not a whole number of days from 0 to 3650`; break; }
      items.push({ legacyDbId: text(item.item_id)!, kind: MILESTONE_KINDS[index]!, label: collapse(label), daysOffset,
        legacyValues: { name: label, daysOffset, sortOrder: whole(item.sort_order) ?? null } });
    }
    if (bad) { skip("milestone_templates", legacyDbId, `${bad}; the template is left out`); continue; }
    templateNames.set(normaliseName(name), legacyDbId);
    const extra = ordered.slice(3);
    const jobsTicked = new Set(extra.flatMap((item) => [...(ticks.get(text(item.item_id) ?? "") ?? [])]));
    const isDefault = flag(row.is_default) ?? false;
    const isActive = flag(row.is_active);
    const description = text(row.description);
    templates.push({
      legacyDbId, name: collapse(name), description, isDefault, active: isActive ?? true, items,
      extras: { items: extra.map((item) => text(item.milestone_name) ?? `item ${item.item_id}`), jobsTicked: jobsTicked.size },
      legacyValues: { name, description, isDefault, isActive, items: items.map((item) => ({ itemId: item.legacyDbId, kind: item.kind, ...item.legacyValues })) },
    });
  }
  for (const [template, rows] of itemsOf) {
    if (!templateIds.has(template)) for (const row of rows) skip("milestone_template_items", text(row.item_id), `an item of template ${template}, which is not in the extract`);
  }

  // Job types
  const jobTypes: PlannedJobType[] = [];
  const typeNames = new Map<string, string>();
  for (const row of [...(extract.job_types ?? [])].sort(byId("job_type_id"))) {
    const legacyDbId = text(row.job_type_id);
    if (!legacyDbId) { skip("job_types", null, "a row with no id"); continue; }
    const name = text(row.name);
    if (!name) { skip("job_types", legacyDbId, "a job type with no name"); continue; }
    const clash = typeNames.get(normaliseName(name));
    if (clash) { skip("job_types", legacyDbId, `the same name as v7 job type ${clash}`); continue; }
    // As the client import resolves a job's family: the type's job_family, then job_group, then v7's name rule — never is_crp.
    const fromFamily = text(row.job_family), fromGroup = text(row.job_group);
    const family = (fromFamily ?? fromGroup ?? familyByV7NameRule(name)).toLowerCase();
    if (!(JOB_TYPE_FAMILIES as readonly string[]).includes(family)) { skip("job_types", legacyDbId, `a family ("${family}") the console does not have`); continue; }
    const price = amount(row.unit_price_ex_vat, 9_999_999_999.99);
    if (price === undefined) { skip("job_types", legacyDbId, "a price that is not an amount from 0, to two places"); continue; }
    const hours = amount(row.estimated_hours, 999_999.99);
    if (hours === undefined) { skip("job_types", legacyDbId, "estimated hours that are not a number from 0, to two places"); continue; }
    typeNames.set(normaliseName(name), legacyDbId);
    const isActive = flag(row.is_active);
    const description = text(row.description);
    const vatLegacyId = text(row.vat_rate_id);
    jobTypes.push({
      legacyDbId, name: collapse(name), family: family as JobTypeFamily, familyFrom: fromFamily ? "job_family" : fromGroup ? "job_group" : "name rule",
      description, defaultPriceExVat: price, estimatedHours: hours, vatLegacyId, active: isActive ?? true,
      legacyValues: { name, jobFamily: fromFamily, jobGroup: fromGroup, isCrp: flag(row.is_crp), description, unitPriceExVat: price, estimatedHours: hours, vatRateId: vatLegacyId, isActive },
    });
  }

  // Job file types
  const fileTypes: PlannedFileType[] = [];
  const displayNames = new Map<string, string>();
  for (const row of [...(extract.job_file_types_lookup ?? [])].sort(byId("file_type_id"))) {
    const legacyDbId = text(row.file_type_id);
    if (!legacyDbId) { skip("job_file_types_lookup", null, "a row with no id"); continue; }
    const key = text(row.file_type_key), displayName = text(row.display_name);
    if (!key || !/^[a-z][a-z0-9_]{1,40}$/.test(key)) { skip("job_file_types_lookup", legacyDbId, `a key ("${key ?? ""}") that is not lower-case letters, digits and underscores`); continue; }
    if (!displayName) { skip("job_file_types_lookup", legacyDbId, "a file type with no display name"); continue; }
    // v7's column default, when a deployment has no folder.
    const folder = text(row.storage_folder_key) ?? "client-provided";
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(folder)) { skip("job_file_types_lookup", legacyDbId, `a storage folder ("${folder}") that is not lower-case letters, digits and hyphens`); continue; }
    const sortOrder = whole(row.sort_order);
    if (sortOrder === undefined || (sortOrder !== null && sortOrder < 0)) { skip("job_file_types_lookup", legacyDbId, "a sort order that is not a whole number from 0"); continue; }
    const clash = displayNames.get(normaliseName(displayName));
    if (clash) { skip("job_file_types_lookup", legacyDbId, `the same display name as v7 file type ${clash}`); continue; }
    displayNames.set(normaliseName(displayName), legacyDbId);
    const isActive = flag(row.is_active);
    fileTypes.push({ legacyDbId, key, displayName: collapse(displayName), folder, sortOrder: sortOrder ?? 0, active: isActive ?? true,
      legacyValues: { key, displayName, folder, sortOrder: sortOrder ?? null, isActive } });
  }

  return {
    vatRates: { values: vatRates, refused: defaultRefusal("VAT rate", vatRates) },
    templates: { values: templates, refused: defaultRefusal("milestone template", templates), noDefault: !templates.some((template) => template.isDefault) },
    jobTypes: { values: jobTypes },
    fileTypes: { values: fileTypes },
    skipped,
  };
}

// ── Loading ───────────────────────────────────────────────────────────────────────────────────────────────────

export type JobsConfigEntity = "vat_rates" | "milestone_templates" | "job_types" | "job_file_types";
export type EntityOutcome = {
  entity: JobsConfigEntity;
  /** The plan refused the entity (defaults) — nothing of it written. */
  refused: string | null;
  /** The entity's savepoint was rolled back — nothing of it written. */
  failed: string | null;
  inserted: number; stamped: number; updated: number; unchanged: number;
  /** R4 and rule refusals: changed in v7 and edited here since, and the like — nothing written for these. */
  conflicts: string[];
  /** Rows the console holds that v7 does not — reported, never archived. */
  seededOnly: string[];
  /** Everything worth saying that is not a refusal: a default kept, a VAT link v7 never set, a system type kept active. */
  notes: string[];
  /** v7's own counts against the console's v7-identified rows, after the load. */
  parity: { v7Active: number; v7Inactive: number; consoleActive: number; consoleInactive: number };
  /** Value-for-value parity where v7 has a typed value (VAT rate; job type price, hours, family): the differences. */
  valueDifferences: string[];
};
export type JobsConfigOutcome = { committed: boolean; runId: string; entities: EntityOutcome[] };

class DryRunRollback extends Error {}

/** jsonb reorders keys; compare what was loaded with what v7 now holds by value, not by text. */
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]))
  : value;
const same = (a: unknown, b: unknown) => a !== null && a !== undefined && JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const byImport = (updatedBy: string) => updatedBy.startsWith(JOBS_CONFIG_RUN_PREFIX);

type Identified = { id: string; source_system: string | null; legacy_db_id: string | null; legacy_values: unknown; updated_by: string; active: boolean };
type Match<R> = { kind: "identity"; row: R } | { kind: "natural"; row: R } | { kind: "none" };

/** Identity first, then the natural key among rows no v7 row has claimed. */
function matchOf<R extends Identified>(existing: readonly R[], claimed: Set<string>, legacyDbId: string, natural: (row: R) => boolean): Match<R> {
  const identity = existing.find((row) => row.source_system === SOURCE_SYSTEM && row.legacy_db_id === legacyDbId);
  if (identity) return { kind: "identity", row: identity };
  const candidates = existing.filter((row) => row.source_system === null && !claimed.has(row.id) && natural(row));
  const row = candidates.find((candidate) => candidate.active) ?? candidates[0];
  return row ? { kind: "natural", row } : { kind: "none" };
}

const emptyOutcome = (entity: JobsConfigEntity, refused: string | null, v7: ReadonlyArray<{ active: boolean }>): EntityOutcome => ({
  entity, refused, failed: null, inserted: 0, stamped: 0, updated: 0, unchanged: 0, conflicts: [], seededOnly: [], notes: [], valueDifferences: [],
  parity: { v7Active: v7.filter((row) => row.active).length, v7Inactive: v7.filter((row) => !row.active).length, consoleActive: 0, consoleInactive: 0 },
});

export async function loadV7JobsConfig(pool: PoolLike, organisationId: string, plan: JobsConfigPlan, options: { commit: boolean; runId?: string }): Promise<JobsConfigOutcome> {
  const runId = options.runId ?? `${JOBS_CONFIG_RUN_PREFIX}${randomUUID()}`;
  if (!runId.startsWith(JOBS_CONFIG_RUN_PREFIX)) throw new Error(`A jobs-configuration run id must start ${JOBS_CONFIG_RUN_PREFIX} — it is how a re-run knows a row is still as an import wrote it.`);
  const outcome: JobsConfigOutcome = { committed: options.commit, runId, entities: [] };
  const steps: Array<{ entity: JobsConfigEntity; refused: string | null; v7: ReadonlyArray<{ active: boolean }>; load: (db: Queryable, result: EntityOutcome) => Promise<void> }> = [
    { entity: "vat_rates", refused: plan.vatRates.refused, v7: plan.vatRates.values, load: (db, result) => loadVatRates(db, organisationId, plan.vatRates.values, runId, result) },
    { entity: "milestone_templates", refused: plan.templates.refused, v7: plan.templates.values, load: (db, result) => loadTemplates(db, organisationId, plan.templates, runId, result) },
    { entity: "job_types", refused: null, v7: plan.jobTypes.values, load: (db, result) => loadJobTypes(db, organisationId, plan.jobTypes.values, runId, result) },
    { entity: "job_file_types", refused: null, v7: plan.fileTypes.values, load: (db, result) => loadFileTypes(db, organisationId, plan.fileTypes.values, runId, result) },
  ];
  try {
    await withTenantWrite(pool, organisationId, async (db) => {
      for (const step of steps) {
        const result = emptyOutcome(step.entity, step.refused, step.v7);
        outcome.entities.push(result);
        if (step.refused) continue;
        await db.query(`SAVEPOINT jobs_config_entity`);
        try {
          await step.load(db, result);
          await audit(db, organisationId, runId, result);
          await db.query(`RELEASE SAVEPOINT jobs_config_entity`);
        } catch (error) {
          await db.query(`ROLLBACK TO SAVEPOINT jobs_config_entity`);
          Object.assign(result, { failed: error instanceof Error ? error.message : String(error), inserted: 0, stamped: 0, updated: 0 });
        }
      }
      if (!options.commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return outcome;
}

async function audit(db: Queryable, org: string, runId: string, result: EntityOutcome) {
  if (result.inserted + result.stamped + result.updated === 0) return;
  await db.query(
    `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, after_json)
     VALUES ($1, $2, $3, 'system', 'jobs_config.imported', 'jobs_configuration', $4, $5, $6, $7::jsonb)`,
    [org, randomUUID(), IMPORT_ACTOR, result.entity, runId, "Jobs configuration reconciled from NZ Insights Pro v7 (admin C4)",
      JSON.stringify({ run: runId, sourceSystem: SOURCE_SYSTEM, entity: result.entity, inserted: result.inserted, stamped: result.stamped, updated: result.updated,
        unchanged: result.unchanged, conflicts: result.conflicts.length, seededOnly: result.seededOnly.length })]);
}

async function parityOf(db: Queryable, org: string, table: string, result: EntityOutcome) {
  const { rows: [row] } = await db.query<{ active: number; inactive: number }>(
    `SELECT count(*) FILTER (WHERE active)::int AS active, count(*) FILTER (WHERE NOT active)::int AS inactive
       FROM nzi_console.${table} WHERE organisation_id = $1 AND source_system = $2`, [org, SOURCE_SYSTEM]);
  result.parity.consoleActive = row?.active ?? 0;
  result.parity.consoleInactive = row?.inactive ?? 0;
}

/**
 * Whether v7's default may be set on `targetId`: yes when the console has none, or its default is this row, or an
 * import set it (v7 moved its default — the import's is cleared). A default the console chose itself stands.
 */
async function claimDefault(db: Queryable, org: string, table: string, idColumn: string, targetId: string, runId: string): Promise<{ allowed: boolean; kept?: string }> {
  const { rows: [current] } = await db.query<{ id: string; name: string; updated_by: string }>(
    `SELECT ${idColumn} AS id, name, updated_by FROM nzi_console.${table} WHERE organisation_id = $1 AND is_default FOR UPDATE`, [org]);
  if (!current || current.id === targetId) return { allowed: true };
  if (!byImport(current.updated_by)) return { allowed: false, kept: current.name };
  await db.query(`UPDATE nzi_console.${table} SET is_default = false, version = version + 1, updated_at = now(), updated_by = $3 WHERE organisation_id = $1 AND ${idColumn} = $2`,
    [org, current.id, runId]);
  return { allowed: true };
}

// ── VAT rates ─────────────────────────────────────────────────────────────────────────────────────────────────

type VatRow = Identified & { name: string; rate_pct: string; is_default: boolean };

async function loadVatRates(db: Queryable, org: string, values: readonly PlannedVatRate[], runId: string, result: EntityOutcome) {
  const { rows: existing } = await db.query<VatRow>(
    `SELECT vat_rate_id AS id, name, rate_pct, is_default, active, source_system, legacy_db_id, legacy_values, updated_by
       FROM nzi_console.vat_rates WHERE organisation_id = $1 ORDER BY vat_rate_id FOR UPDATE`, [org]);
  const claimed = new Set<string>();
  // The default last: every other rate is settled before the one-default index is asked to move.
  for (const value of [...values].sort((a, b) => Number(a.isDefault) - Number(b.isDefault))) {
    const match = matchOf(existing, claimed, value.legacyDbId, (row) => Number(row.rate_pct) === value.ratePct
      && (normaliseName(row.name) === normaliseName(value.name) || existing.filter((other) => other.source_system === null && Number(other.rate_pct) === value.ratePct).length === 1));
    if (match.kind !== "none") claimed.add(match.row.id);
    if (match.kind === "identity") {
      if (same(match.row.legacy_values, value.legacyValues)) { result.unchanged += 1; continue; }
      if (!byImport(match.row.updated_by)) { result.conflicts.push(`${match.row.name}: changed in v7 since the last load, and edited here since`); continue; }
    }
    const id = match.kind === "none" ? `vat:v7-${value.legacyDbId}` : match.row.id;
    let isDefault = match.kind === "none" ? false : match.row.is_default;
    if (value.isDefault) {
      const claim = await claimDefault(db, org, "vat_rates", "vat_rate_id", id, runId);
      if (claim.allowed) isDefault = true;
      else result.notes.push(`the console's own default VAT rate "${claim.kept}" stands; v7's default "${value.name}" is loaded as not the default`);
    } else if (match.kind === "identity" && byImport(match.row.updated_by)) isDefault = false;
    const active = isDefault ? true : value.active;
    if (match.kind === "none") {
      await db.query(
        `INSERT INTO nzi_console.vat_rates (organisation_id, vat_rate_id, name, rate_pct, is_default, active, source_system, legacy_db_id, legacy_values, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $10)`,
        [org, id, value.name, value.ratePct, isDefault, active, SOURCE_SYSTEM, value.legacyDbId, JSON.stringify(value.legacyValues), runId]);
      result.inserted += 1;
    } else {
      await db.query(
        `UPDATE nzi_console.vat_rates SET name = $3, rate_pct = $4, is_default = $5, active = $6, source_system = $7, legacy_db_id = $8, legacy_values = $9::jsonb,
                version = version + 1, updated_at = now(), updated_by = $10
          WHERE organisation_id = $1 AND vat_rate_id = $2`,
        [org, id, value.name, value.ratePct, isDefault, active, SOURCE_SYSTEM, value.legacyDbId, JSON.stringify(value.legacyValues), runId]);
      if (match.kind === "identity") result.updated += 1; else result.stamped += 1;
    }
  }
  result.seededOnly = existing.filter((row) => row.source_system === null && !claimed.has(row.id)).map((row) => row.name);
  await parityOf(db, org, "vat_rates", result);
  const { rows } = await db.query<{ legacy_db_id: string; name: string; rate_pct: string }>(
    `SELECT legacy_db_id, name, rate_pct FROM nzi_console.vat_rates WHERE organisation_id = $1 AND source_system = $2`, [org, SOURCE_SYSTEM]);
  for (const value of values) {
    const row = rows.find((candidate) => candidate.legacy_db_id === value.legacyDbId);
    if (row && Number(row.rate_pct) !== value.ratePct) result.valueDifferences.push(`${value.name}: v7 ${value.ratePct}%, here ${Number(row.rate_pct)}%`);
  }
  if (!values.some((value) => value.isDefault)) result.notes.push("v7 has no default VAT rate");
}

// ── Milestone templates and their items ─────────────────────────────────────────────────────────────────────────

type TemplateRow = Identified & { name: string; is_default: boolean };
type ItemRow = { kind: MilestoneKind; label: string; days_offset: number; included: boolean; legacy_db_id: string | null };

async function loadTemplates(db: Queryable, org: string, planned: JobsConfigPlan["templates"], runId: string, result: EntityOutcome) {
  const { rows: existing } = await db.query<TemplateRow>(
    `SELECT template_id AS id, name, is_default, active, source_system, legacy_db_id, legacy_values, updated_by
       FROM nzi_console.milestone_templates WHERE organisation_id = $1 ORDER BY template_id FOR UPDATE`, [org]);
  const claimed = new Set<string>();
  for (const value of [...planned.values].sort((a, b) => Number(a.isDefault) - Number(b.isDefault))) {
    const match = matchOf(existing, claimed, value.legacyDbId, (row) => normaliseName(row.name) === normaliseName(value.name));
    if (match.kind !== "none") claimed.add(match.row.id);
    if (match.kind === "identity") {
      if (same(match.row.legacy_values, value.legacyValues)) { result.unchanged += 1; continue; }
      // A template edited here (C2's command stamps its updated_by, items and all) is never overwritten.
      if (!byImport(match.row.updated_by)) { result.conflicts.push(`${match.row.name}: changed in v7 since the last load, and edited here since`); continue; }
    }
    const id = match.kind === "none" ? `milestone-template:v7-${value.legacyDbId}` : match.row.id;
    let isDefault = match.kind === "none" ? false : match.row.is_default;
    if (value.isDefault) {
      const claim = await claimDefault(db, org, "milestone_templates", "template_id", id, runId);
      if (claim.allowed) isDefault = true;
      else result.notes.push(`the console's own default template "${claim.kept}" stands; v7's default "${value.name}" is loaded as not the default`);
    } else if (match.kind === "identity" && byImport(match.row.updated_by)) isDefault = false;
    const active = isDefault ? true : value.active;
    if (!value.active && isDefault) result.notes.push(`"${value.name}" is kept active: it is the default`);
    if (match.kind === "none") {
      await db.query(
        `INSERT INTO nzi_console.milestone_templates (organisation_id, template_id, name, description, is_default, active, source_system, legacy_db_id, legacy_values, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $10)`,
        [org, id, value.name, value.description, isDefault, active, SOURCE_SYSTEM, value.legacyDbId, JSON.stringify(value.legacyValues), runId]);
      result.inserted += 1;
    } else {
      await db.query(
        `UPDATE nzi_console.milestone_templates SET name = $3, description = $4, is_default = $5, active = $6, source_system = $7, legacy_db_id = $8,
                legacy_values = $9::jsonb, version = version + 1, updated_at = now(), updated_by = $10
          WHERE organisation_id = $1 AND template_id = $2`,
        [org, id, value.name, value.description, isDefault, active, SOURCE_SYSTEM, value.legacyDbId, JSON.stringify(value.legacyValues), runId]);
      if (match.kind === "identity") result.updated += 1; else result.stamped += 1;
    }
    await writeItems(db, org, id, value.items, runId);
    if (value.extras.items.length) {
      result.notes.push(`"${value.name}": ${value.extras.items.length} item(s) beyond the third not carried (${value.extras.items.join(", ")}) — undated in v7; ${value.extras.jobsTicked} job(s) ticked them (Q5)`);
    }
  }
  result.seededOnly = existing.filter((row) => row.source_system === null && !claimed.has(row.id)).map((row) => row.name);
  await parityOf(db, org, "milestone_templates", result);
  if (planned.noDefault) result.notes.push("v7 has no default template: PR 3 generates nothing for a job whose type names no template until one is chosen");
}

/**
 * The first three items, by kind. A kind v7 no longer has is kept and not included (never deleted). An item's v7 id
 * can move between kinds when v7 reorders, so this template's identities are released first and set again.
 */
async function writeItems(db: Queryable, org: string, templateId: string, items: readonly PlannedTemplateItem[], runId: string) {
  const { rows: before } = await db.query<ItemRow>(
    `SELECT kind, label, days_offset, included, legacy_db_id FROM nzi_console.milestone_template_items WHERE organisation_id = $1 AND template_id = $2 FOR UPDATE`, [org, templateId]);
  await db.query(
    `UPDATE nzi_console.milestone_template_items SET source_system = NULL, legacy_db_id = NULL, legacy_values = NULL
      WHERE organisation_id = $1 AND template_id = $2 AND source_system IS NOT NULL`, [org, templateId]);
  for (const kind of MILESTONE_KINDS) {
    const item = items.find((candidate) => candidate.kind === kind);
    const current = before.find((row) => row.kind === kind);
    if (item) {
      if (!current) {
        await db.query(
          `INSERT INTO nzi_console.milestone_template_items (organisation_id, template_id, kind, label, days_offset, included, source_system, legacy_db_id, legacy_values, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8::jsonb, $9, $9)`,
          [org, templateId, kind, item.label, item.daysOffset, SOURCE_SYSTEM, item.legacyDbId, JSON.stringify(item.legacyValues), runId]);
      } else {
        const changed = current.label !== item.label || current.days_offset !== item.daysOffset || !current.included || current.legacy_db_id !== item.legacyDbId;
        await db.query(
          `UPDATE nzi_console.milestone_template_items SET label = $4, days_offset = $5, included = true, source_system = $6, legacy_db_id = $7, legacy_values = $8::jsonb,
                  version = version + $9, updated_at = CASE WHEN $9 = 1 THEN now() ELSE updated_at END, updated_by = CASE WHEN $9 = 1 THEN $10 ELSE updated_by END
            WHERE organisation_id = $1 AND template_id = $2 AND kind = $3`,
          [org, templateId, kind, item.label, item.daysOffset, SOURCE_SYSTEM, item.legacyDbId, JSON.stringify(item.legacyValues), changed ? 1 : 0, runId]);
      }
    } else if (current?.included) {
      await db.query(
        `UPDATE nzi_console.milestone_template_items SET included = false, version = version + 1, updated_at = now(), updated_by = $4
          WHERE organisation_id = $1 AND template_id = $2 AND kind = $3`, [org, templateId, kind, runId]);
    }
  }
}

// ── Job types ─────────────────────────────────────────────────────────────────────────────────────────────────

type JobTypeRow = Identified & { name: string; family: JobTypeFamily; default_price_ex_vat: string | null; estimated_hours: string | null; vat_rate_id: string | null };

async function loadJobTypes(db: Queryable, org: string, values: readonly PlannedJobType[], runId: string, result: EntityOutcome) {
  const { rows: existing } = await db.query<JobTypeRow>(
    `SELECT job_type_id AS id, name, family, default_price_ex_vat, estimated_hours, vat_rate_id, active, source_system, legacy_db_id, legacy_values, updated_by
       FROM nzi_console.job_types WHERE organisation_id = $1 ORDER BY job_type_id FOR UPDATE`, [org]);
  // VAT rates by their v7 id — those this run (or an earlier one) loaded.
  const { rows: rates } = await db.query<{ vat_rate_id: string; legacy_db_id: string }>(
    `SELECT vat_rate_id, legacy_db_id FROM nzi_console.vat_rates WHERE organisation_id = $1 AND source_system = $2`, [org, SOURCE_SYSTEM]);
  const vatOf = new Map(rates.map((rate) => [rate.legacy_db_id, rate.vat_rate_id]));
  const claimed = new Set<string>();
  let noVat = 0;
  for (const value of values) {
    const match = matchOf(existing, claimed, value.legacyDbId, (row) => normaliseName(row.name) === normaliseName(value.name));
    if (match.kind !== "none") claimed.add(match.row.id);
    if (match.kind === "identity") {
      if (same(match.row.legacy_values, value.legacyValues)) { result.unchanged += 1; continue; }
      if (!byImport(match.row.updated_by)) { result.conflicts.push(`${match.row.name}: changed in v7 since the last load, and edited here since`); continue; }
    }
    if (match.kind !== "none" && match.row.family !== value.family) {
      // Q4: a job carries its family, so a type's family does not change under its jobs — the command's rule, held here too.
      const { rows: [usage] } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM nzi_console.jobs WHERE organisation_id = $1 AND job_type_id = $2`, [org, match.row.id]);
      if ((usage?.n ?? 0) > 0) { result.conflicts.push(`${match.row.name}: v7's family is ${value.family}, but ${usage!.n} job(s) of this type carry ${match.row.family}`); continue; }
    }
    const vatRateId = value.vatLegacyId ? vatOf.get(value.vatLegacyId) ?? null : null;
    if (!value.vatLegacyId) noVat += 1;
    else if (!vatRateId) result.notes.push(`${value.name}: v7's VAT rate ${value.vatLegacyId} is not loaded here, so no VAT rate is linked`);
    const id = match.kind === "none" ? `job-type:v7-${value.legacyDbId}` : match.row.id;
    if (match.kind === "none") {
      await db.query(
        `INSERT INTO nzi_console.job_types (organisation_id, job_type_id, name, family, description, default_price_ex_vat, estimated_hours, vat_rate_id, active,
           source_system, legacy_db_id, legacy_values, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $13)`,
        [org, id, value.name, value.family, value.description, value.defaultPriceExVat, value.estimatedHours, vatRateId, value.active,
          SOURCE_SYSTEM, value.legacyDbId, JSON.stringify(value.legacyValues), runId]);
      result.inserted += 1;
    } else {
      // The template link is the console's own (v7 has none — Q8), so an import never touches it; nor the code (Q3).
      await db.query(
        `UPDATE nzi_console.job_types SET name = $3, family = $4, description = $5, default_price_ex_vat = $6, estimated_hours = $7, vat_rate_id = $8, active = $9,
                source_system = $10, legacy_db_id = $11, legacy_values = $12::jsonb, version = version + 1, updated_at = now(), updated_by = $13
          WHERE organisation_id = $1 AND job_type_id = $2`,
        [org, id, value.name, value.family, value.description, value.defaultPriceExVat, value.estimatedHours, vatRateId, value.active,
          SOURCE_SYSTEM, value.legacyDbId, JSON.stringify(value.legacyValues), runId]);
      if (match.kind === "identity") result.updated += 1; else result.stamped += 1;
    }
  }
  if (noVat) result.notes.push(`${noVat} job type(s) have no VAT rate in v7 (v7's routes never set one), so none is linked`);
  const fromRule = values.filter((value) => value.familyFrom === "name rule").length;
  if (fromRule) result.notes.push(`${fromRule} job type(s) have no job_family or job_group in v7; their family is v7's own name rule, as the client import resolves it`);
  result.seededOnly = existing.filter((row) => row.source_system === null && !claimed.has(row.id)).map((row) => row.name);
  await parityOf(db, org, "job_types", result);
  const { rows } = await db.query<{ legacy_db_id: string; family: string; default_price_ex_vat: string | null; estimated_hours: string | null }>(
    `SELECT legacy_db_id, family, default_price_ex_vat, estimated_hours FROM nzi_console.job_types WHERE organisation_id = $1 AND source_system = $2`, [org, SOURCE_SYSTEM]);
  const num = (value: string | null) => value === null ? null : Number(value);
  for (const value of values) {
    const row = rows.find((candidate) => candidate.legacy_db_id === value.legacyDbId);
    if (!row) continue;
    if (row.family !== value.family) result.valueDifferences.push(`${value.name}: family v7 ${value.family}, here ${row.family}`);
    if (num(row.default_price_ex_vat) !== value.defaultPriceExVat) result.valueDifferences.push(`${value.name}: price v7 ${value.defaultPriceExVat}, here ${num(row.default_price_ex_vat)}`);
    if (num(row.estimated_hours) !== value.estimatedHours) result.valueDifferences.push(`${value.name}: hours v7 ${value.estimatedHours}, here ${num(row.estimated_hours)}`);
  }
}

// ── Job file types ────────────────────────────────────────────────────────────────────────────────────────────

type FileTypeRow = Identified & { file_type_key: string; display_name: string; is_system: boolean };

async function loadFileTypes(db: Queryable, org: string, values: readonly PlannedFileType[], runId: string, result: EntityOutcome) {
  const { rows: existing } = await db.query<FileTypeRow>(
    `SELECT file_type_id AS id, file_type_key, display_name, is_system, active, source_system, legacy_db_id, legacy_values, updated_by
       FROM nzi_console.job_file_types WHERE organisation_id = $1 ORDER BY file_type_id FOR UPDATE`, [org]);
  const claimed = new Set<string>();
  for (const value of values) {
    const match = matchOf(existing, claimed, value.legacyDbId, (row) => row.file_type_key === value.key);
    if (match.kind !== "none") claimed.add(match.row.id);
    if (match.kind === "identity") {
      if (same(match.row.legacy_values, value.legacyValues)) { result.unchanged += 1; continue; }
      if (!byImport(match.row.updated_by)) { result.conflicts.push(`${match.row.display_name}: changed in v7 since the last load, and edited here since`); continue; }
      // A key never changes here (0139 grants no UPDATE on it) — v7 does not allow it either.
      if (match.row.file_type_key !== value.key) { result.conflicts.push(`${match.row.display_name}: v7's key is now ${value.key}; a key never changes here`); continue; }
    }
    // A system type is always active (0139); v7's core keys cannot be archived there either.
    const active = match.kind !== "none" && match.row.is_system ? true : value.active;
    if (match.kind !== "none" && match.row.is_system && !value.active) result.notes.push(`${value.key}: inactive in v7, kept active — it is a system type`);
    if (match.kind === "none") {
      await db.query(
        `INSERT INTO nzi_console.job_file_types (organisation_id, file_type_id, file_type_key, display_name, storage_folder_key, sort_order, active,
           source_system, legacy_db_id, legacy_values, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $11)`,
        [org, `file-type:v7-${value.legacyDbId}`, value.key, value.displayName, value.folder, value.sortOrder, active, SOURCE_SYSTEM, value.legacyDbId, JSON.stringify(value.legacyValues), runId]);
      result.inserted += 1;
    } else {
      await db.query(
        `UPDATE nzi_console.job_file_types SET display_name = $3, storage_folder_key = $4, sort_order = $5, active = $6, source_system = $7, legacy_db_id = $8,
                legacy_values = $9::jsonb, version = version + 1, updated_at = now(), updated_by = $10
          WHERE organisation_id = $1 AND file_type_id = $2`,
        [org, match.row.id, value.displayName, value.folder, value.sortOrder, active, SOURCE_SYSTEM, value.legacyDbId, JSON.stringify(value.legacyValues), runId]);
      if (match.kind === "identity") result.updated += 1; else result.stamped += 1;
    }
  }
  result.seededOnly = existing.filter((row) => row.source_system === null && !claimed.has(row.id)).map((row) => `${row.display_name} (${row.file_type_key})`);
  await parityOf(db, org, "job_file_types", result);
}
