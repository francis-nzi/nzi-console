import { randomUUID } from "node:crypto";
import {
  CUSTOM_FIELD_KEY_PATTERN, CUSTOM_FIELD_LABEL_MAX, CUSTOM_FIELD_OPTION_LABEL_MAX, CUSTOM_FIELD_OPTION_VALUE_PATTERN, customFieldOptionIssues, customFieldValueIssue,
  isCustomFieldEntityType, V7_CUSTOM_FIELD_TYPE_MAP, type CustomFieldEntityType, type CustomFieldOption, type CustomFieldType,
} from "@nzi/contracts";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { IMPORT_ACTOR, SOURCE_SYSTEM } from "./v7ClientImport";
import type { V7Row, V7Table } from "./v7ClientExtract";

/**
 * The v7 custom-field-definition import (admin Phase F3, `load:v7-custom-fields`; ruled `phaseF-comms-crm-plan.md`
 * F-Q5): v7's `custom_field_definitions` → 0151's, **definitions only** — v7's values are the entity workstreams' to carry
 * (`docs/CUSTOM_FIELD_VALUES_CONTRACT.md`).
 *
 * v7's definitions are global (no organisation); they load into the organisation named. **The plan (pure)** takes each:
 * its entity, its key (v7's `field_name`, lower-cased; one that cannot be a console key is left out), its type (mapped —
 * v7's "option" radio buttons it rendered as a select), its label, required flag, order, options (`[{value, label}]`,
 * each made active) and default (one not valid for its type is dropped, and noted). v7 does not keep a key unique per
 * entity: of two, the active one is taken (else the first), and the other reported.
 *
 * **The load**: per definition, its v7 identity; else the same entity and key a person made here — stamped, its own
 * wording standing; else inserted. Re-runs (R4): unchanged → left alone; changed and still as an import wrote it → v7
 * wins, **except** that a type never changes (refused, named) and an option is never removed (one v7 dropped is kept,
 * deactivated); edited here since → refused. Nothing is deleted. The audit event is counts only.
 *
 * One transaction; a dry run is the whole load, rolled back.
 */

export const CUSTOM_FIELDS_RUN_PREFIX = "v7-custom-fields-";
export const V7_CUSTOM_FIELD_TABLES: readonly V7Table[] = ["custom_field_definitions"];

const text = (value: string | null | undefined) => { const trimmed = value?.trim(); return trimmed ? trimmed : null; };
const collapse = (value: string) => value.trim().replace(/\s+/g, " ");
const flag = (value: string | null | undefined): boolean | null => {
  const v = value?.trim().toLowerCase();
  return v === "t" || v === "true" || v === "1" ? true : v === "f" || v === "false" || v === "0" ? false : null;
};

export type PlannedCustomField = {
  legacyDbId: string; entityType: CustomFieldEntityType; key: string; type: CustomFieldType; label: string; required: boolean; sortOrder: number;
  options: CustomFieldOption[] | null; defaultValue: string | null; active: boolean; legacyValues: Record<string, unknown>;
};
export type CustomFieldsPlan = { values: PlannedCustomField[]; skipped: Array<{ legacyDbId: string; reason: string }>; notes: string[] };

/** v7's options JSON (`[{value, label}]`, as the extract carries it) → active console options, or why not. */
function parseOptions(raw: string | null): { options: CustomFieldOption[] | null; problem?: string } {
  if (raw === null) return { options: null };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { options: null, problem: "options that are not JSON" }; }
  if (parsed === null) return { options: null };
  if (!Array.isArray(parsed)) return { options: null, problem: "options that are not a list" };
  const options: CustomFieldOption[] = [];
  for (const entry of parsed) {
    const value = typeof entry === "string" ? entry : entry && typeof entry === "object" ? String((entry as Record<string, unknown>).value ?? "") : "";
    const label = typeof entry === "string" ? entry : entry && typeof entry === "object" ? String((entry as Record<string, unknown>).label ?? value) : "";
    if (!CUSTOM_FIELD_OPTION_VALUE_PATTERN.test(value.trim())) return { options: null, problem: `an option value ("${value}") that cannot be a console option value` };
    options.push({ value: value.trim(), label: collapse(label).slice(0, CUSTOM_FIELD_OPTION_LABEL_MAX) || value.trim(), active: true });
  }
  return { options };
}

export function planV7CustomFields(extract: Partial<Record<V7Table, readonly V7Row[]>>): CustomFieldsPlan {
  const plan: CustomFieldsPlan = { values: [], skipped: [], notes: [] };
  // The active one first, then by id — so of two definitions sharing a key, the active one is taken.
  const rows = [...(extract.custom_field_definitions ?? [])].sort((a, b) =>
    Number(flag(b.is_active) ?? true) - Number(flag(a.is_active) ?? true) || Number(a.field_id) - Number(b.field_id));
  const taken = new Map<string, string>();
  for (const row of rows) {
    const legacyDbId = text(row.field_id);
    if (!legacyDbId) { plan.skipped.push({ legacyDbId: "(blank)", reason: "a row with no id" }); continue; }
    const skip = (reason: string) => plan.skipped.push({ legacyDbId, reason });
    const entityType = text(row.entity_type)?.toLowerCase();
    if (!isCustomFieldEntityType(entityType)) { skip(`entity "${row.entity_type ?? ""}" is not one the console knows`); continue; }
    const key = (text(row.field_name) ?? "").toLowerCase();
    if (!CUSTOM_FIELD_KEY_PATTERN.test(key)) { skip(`key "${row.field_name ?? ""}" is not a console key (lower-case letters, digits, _ and -, starting with a letter, up to 64)`); continue; }
    const identity = `${entityType}:${key}`;
    if (taken.has(identity)) { skip(`the same ${entityType} key as v7 field ${taken.get(identity)}`); continue; }
    const type = V7_CUSTOM_FIELD_TYPE_MAP[(text(row.field_type) ?? "").toLowerCase()];
    if (!type) { skip(`type "${row.field_type ?? ""}" has no console equivalent`); continue; }
    const rawLabel = text(row.field_label);
    if (!rawLabel) { skip("a field with no label"); continue; }
    const label = collapse(rawLabel);
    if (label.length > CUSTOM_FIELD_LABEL_MAX) { skip(`a label longer than ${CUSTOM_FIELD_LABEL_MAX} characters`); continue; }
    const parsed = parseOptions(text(row.options));
    if (parsed.problem) { skip(parsed.problem); continue; }
    const options = type === "select" ? parsed.options ?? [] : null;
    const optionProblems = customFieldOptionIssues(type, options);
    if (optionProblems.length) { skip(optionProblems.join(" ")); continue; }
    if (type !== "select" && parsed.options?.length) plan.notes.push(`${entityType}.${key}: v7 holds options on a ${row.field_type} field — not carried (only a choice-from-a-list field has options)`);
    let defaultValue = text(row.default_value);
    if (defaultValue !== null && customFieldValueIssue(type, defaultValue, options)) {
      plan.notes.push(`${entityType}.${key}: v7's default is not valid for a ${type} field — left blank`);
      defaultValue = null;
    }
    if ((text(row.field_type) ?? "").toLowerCase() === "option") plan.notes.push(`${entityType}.${key}: v7's radio-button field becomes a choice from a list (v7 drew it as one)`);
    const rawOrder = Number(text(row.display_order) ?? "0");
    taken.set(identity, legacyDbId);
    plan.values.push({
      legacyDbId, entityType, key, type, label, required: flag(row.is_required) ?? false, sortOrder: Number.isInteger(rawOrder) && rawOrder >= 0 ? rawOrder : 0,
      options, defaultValue, active: flag(row.is_active) ?? true,
      legacyValues: { fieldName: row.field_name, fieldType: row.field_type, fieldLabel: rawLabel, entityType: row.entity_type, isRequired: row.is_required ?? null,
        options: text(row.options), displayOrder: row.display_order ?? null, isActive: row.is_active ?? null, defaultValue: row.default_value ?? null },
    });
  }
  plan.values.sort((a, b) => a.entityType.localeCompare(b.entityType) || a.sortOrder - b.sortOrder || Number(a.legacyDbId) - Number(b.legacyDbId));
  return plan;
}

// ── Loading ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type CustomFieldsOutcome = {
  committed: boolean; runId: string;
  inserted: number; stamped: number; updated: number; unchanged: number;
  refused: string[]; notes: string[];
  /** entity.key here that v7 does not hold — reported, never deactivated. */
  hereOnly: string[];
  parity: { v7Active: number; v7Inactive: number; consoleActive: number; consoleInactive: number };
};

class DryRunRollback extends Error {}
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]))
  : value;
const same = (a: unknown, b: unknown) => a !== null && a !== undefined && JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const byImport = (actor: string) => actor.startsWith(CUSTOM_FIELDS_RUN_PREFIX);

type Held = { definition_id: string; entity_type: string; field_key: string; field_type: string; options: CustomFieldOption[] | null;
  source_system: string | null; legacy_db_id: string | null; legacy_values: unknown; updated_by: string };

export async function loadV7CustomFields(pool: PoolLike, organisationId: string, plan: CustomFieldsPlan, options: { commit: boolean; runId?: string }): Promise<CustomFieldsOutcome> {
  const runId = options.runId ?? `${CUSTOM_FIELDS_RUN_PREFIX}${randomUUID()}`;
  if (!runId.startsWith(CUSTOM_FIELDS_RUN_PREFIX)) throw new Error(`A custom-fields run id must start ${CUSTOM_FIELDS_RUN_PREFIX} — it is how a re-run knows a row is still as an import wrote it.`);
  const outcome: CustomFieldsOutcome = {
    committed: options.commit, runId, inserted: 0, stamped: 0, updated: 0, unchanged: 0, refused: [], notes: [...plan.notes], hereOnly: [],
    parity: { v7Active: plan.values.filter((value) => value.active).length, v7Inactive: plan.values.filter((value) => !value.active).length, consoleActive: 0, consoleInactive: 0 },
  };
  try {
    await withTenantWrite(pool, organisationId, async (db) => {
      await reconcile(db, organisationId, plan, runId, outcome);
      if (outcome.inserted + outcome.stamped + outcome.updated > 0) {
        await db.query(
          `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, after_json)
           VALUES ($1, $2, $3, 'system', 'custom_fields.imported', 'custom_fields', 'custom_fields', $4, $5, $6::jsonb)`,
          [organisationId, randomUUID(), IMPORT_ACTOR, runId, "Custom field definitions reconciled from NZ Insights Pro v7 (admin F3)",
            JSON.stringify({ run: runId, sourceSystem: SOURCE_SYSTEM, inserted: outcome.inserted, stamped: outcome.stamped, updated: outcome.updated,
              unchanged: outcome.unchanged, refused: outcome.refused.length })]);
      }
      if (!options.commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return outcome;
}

async function reconcile(db: Queryable, org: string, plan: CustomFieldsPlan, runId: string, outcome: CustomFieldsOutcome) {
  const { rows: held } = await db.query<Held>(
    `SELECT definition_id, entity_type, field_key, field_type, options, source_system, legacy_db_id, legacy_values, updated_by
       FROM nzi_console.custom_field_definitions WHERE organisation_id = $1 ORDER BY definition_id FOR UPDATE`, [org]);
  const claimed = new Set<string>();
  for (const value of plan.values) {
    const name = `${value.entityType}.${value.key}`;
    const identity = held.find((row) => row.source_system === SOURCE_SYSTEM && row.legacy_db_id === value.legacyDbId);
    if (identity) {
      claimed.add(identity.definition_id);
      if (same(identity.legacy_values, value.legacyValues)) { outcome.unchanged += 1; continue; }
      if (!byImport(identity.updated_by)) { outcome.refused.push(`${name}: changed in v7 since the last load, and edited here since (R4)`); continue; }
      if (identity.field_type !== value.type || identity.field_key !== value.key || identity.entity_type !== value.entityType) {
        outcome.refused.push(`${name}: v7 changed its ${identity.field_type !== value.type ? `type (${identity.field_type} → ${value.type})` : "key or entity"}, which never changes here — make a new field instead`);
        continue;
      }
      // An option v7 dropped is kept, deactivated: a value held downstream may still name it.
      const kept = (identity.options ?? []).filter((option) => !(value.options ?? []).some((next) => next.value === option.value)).map((option) => ({ ...option, active: false }));
      if (kept.length) outcome.notes.push(`${name}: v7 no longer offers ${kept.map((option) => `"${option.value}"`).join(", ")} — kept here, deactivated`);
      const options = value.options === null ? null : [...value.options, ...kept];
      await db.query(
        `UPDATE nzi_console.custom_field_definitions SET label = $3, required = $4, sort_order = $5, options = $6::jsonb, default_value = $7, active = $8, legacy_values = $9::jsonb,
                version = version + 1, updated_at = now(), updated_by = $10 WHERE organisation_id = $1 AND definition_id = $2`,
        [org, identity.definition_id, value.label, value.required, value.sortOrder, options === null ? null : JSON.stringify(options), value.defaultValue, value.active,
          JSON.stringify(value.legacyValues), runId]);
      outcome.updated += 1;
      continue;
    }
    const natural = held.find((row) => row.source_system === null && !claimed.has(row.definition_id) && row.entity_type === value.entityType && row.field_key === value.key);
    if (natural) {
      claimed.add(natural.definition_id);
      if (natural.field_type !== value.type) { outcome.refused.push(`${name}: held here as a ${natural.field_type} field, v7 has it as ${value.type} — not stamped`); continue; }
      await db.query(
        `UPDATE nzi_console.custom_field_definitions SET source_system = $3, legacy_db_id = $4, legacy_values = $5::jsonb, version = version + 1, updated_at = now()
          WHERE organisation_id = $1 AND definition_id = $2`, [org, natural.definition_id, SOURCE_SYSTEM, value.legacyDbId, JSON.stringify(value.legacyValues)]);
      outcome.notes.push(`${name}: already held here — stamped with v7's identity; its own label, options and state stand`);
      outcome.stamped += 1;
      continue;
    }
    await db.query(
      `INSERT INTO nzi_console.custom_field_definitions (organisation_id, definition_id, entity_type, field_key, field_type, label, required, sort_order, options, default_value,
         active, source_system, legacy_db_id, legacy_values, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14::jsonb, $15, $15)`,
      [org, `custom-field:v7-${value.legacyDbId}`, value.entityType, value.key, value.type, value.label, value.required, value.sortOrder,
        value.options === null ? null : JSON.stringify(value.options), value.defaultValue, value.active, SOURCE_SYSTEM, value.legacyDbId, JSON.stringify(value.legacyValues), runId]);
    outcome.inserted += 1;
  }
  outcome.hereOnly = held.filter((row) => !claimed.has(row.definition_id)).map((row) => `${row.entity_type}.${row.field_key}`);
  const { rows: [parity] } = await db.query<{ active: number; inactive: number }>(
    `SELECT count(*) FILTER (WHERE active)::int AS active, count(*) FILTER (WHERE NOT active)::int AS inactive
       FROM nzi_console.custom_field_definitions WHERE organisation_id = $1 AND source_system = $2`, [org, SOURCE_SYSTEM]);
  outcome.parity.consoleActive = parity?.active ?? 0;
  outcome.parity.consoleInactive = parity?.inactive ?? 0;
}
