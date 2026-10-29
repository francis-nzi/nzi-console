// Data-entry templates R1 (0197, ruled 29 Oct 2026: BUILD-data-entry-templates.md) — the organisation's master
// templates: `Master · Default`, `Master · Construction`, `Master · Office`, authored in admin under admin.lookups.
//
// A header (name, active, the lines' version in force) and its lines, versioned whole: `master.template.rows.set` writes
// the next rows version and points the header at it; the version before stays readable (append-only, 0159's rule).
// Renamed, archived (with a reason) and reinstated in place — never deleted (0147's rule). An archived master is
// read-only until it is reinstated. A line is scope · category · labels · factor identity · unit: no site, no dataset, no
// quantity — the contract refuses one that carries any of them, and the table has no column to hold it.
//
// Every write runs through the command runner (idempotency, expectedVersion on the header, audit with before and after).
// The audit carries the name and the lines' shape in counts — never a line's label (NZC-120).
import { randomUUID } from "node:crypto";
import { masterFactorServes, type CommandContext, type CommandInputMap, type MasterTemplate, type MasterTemplateFactorOption, type MasterTemplateRow,
  type MasterTemplateRowInput, type MasterTemplatesReadModel, type ReportingTemplateScope } from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import { listReportingTemplateCategories } from "./clientReportingTemplateRecords";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";

// ── Reading ────────────────────────────────────────────────────────────────────────────────────────────────────────

type HeaderRow = { master_id: string; name: string; active: boolean; archived_reason: string | null; rows_version: number; version: number; updated_by: string; updated_at: Date | string };

const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : String(value);

/** One rows version of a master, in order, with the category's name and the factor's curated label read for display. */
export async function readMasterTemplateRows(db: Queryable, masterId: string, rowsVersion: number): Promise<MasterTemplateRow[]> {
  if (rowsVersion === 0) return [];
  const { rows } = await db.query<{ row_id: string; scope: ReportingTemplateScope; category_code: string; source_label: string; report_label: string | null;
    factor_id: string | null; unit: string | null; ordering: number; category_name: string | null; factor_label: string | null }>(
    `SELECT r.row_id, r.scope, r.category_code, r.source_label, r.report_label, r.factor_id, r.unit, r.ordering,
            c.name AS category_name, i.label AS factor_label
       FROM nzi_console.master_template_rows r
       LEFT JOIN nzi_console.input_spec_categories c ON c.category_code = r.category_code
       LEFT JOIN nzi_console.factor_identities i ON (i.organisation_id, i.factor_id) = (r.organisation_id, r.factor_id)
      WHERE r.master_id = $1 AND r.rows_version = $2
      ORDER BY r.ordering, r.row_id`, [masterId, rowsVersion]);
  return rows.map((row) => ({
    rowId: row.row_id, ordering: row.ordering, scope: row.scope, categoryCode: row.category_code, sourceLabel: row.source_label,
    reportLabel: row.report_label, factorId: row.factor_id, unit: row.unit, categoryName: row.category_name, factorLabel: row.factor_label,
  }));
}

/**
 * The activities a master line may name: one per factor identity, with the scopes and unit of its newest active edition
 * — the same factors the capture accordion offers a job, without a job's dataset selection to narrow them.
 */
export async function listMasterTemplateFactorOptions(db: Queryable): Promise<MasterTemplateFactorOption[]> {
  const { rows } = await db.query<{ factor_id: string; label: string; activity_unit: string | null; scopes: string[] }>(
    `SELECT DISTINCT ON (i.factor_id) i.factor_id, i.label, f.activity_unit, f.scopes
       FROM nzi_console.factor_identities i
       JOIN nzi_console.emission_factors f ON (f.organisation_id, f.factor_id) = (i.organisation_id, i.factor_id) AND f.active
       JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id, d.dataset_id) = (f.organisation_id, f.dataset_id)
      ORDER BY i.factor_id, d.valid_from DESC, d.dataset_id`);
  return rows.map((row) => ({ factorId: row.factor_id, label: row.label, unit: row.activity_unit, scopes: row.scopes }))
    .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()) || a.factorId.localeCompare(b.factorId));
}

/** Every master, active first then by name, each with its lines in force. */
export async function listMasterTemplates(db: Queryable): Promise<MasterTemplate[]> {
  const { rows } = await db.query<HeaderRow>(
    `SELECT master_id, name, active, archived_reason, rows_version, version, updated_by, updated_at
       FROM nzi_console.master_templates ORDER BY active DESC, lower(name), master_id`);
  const masters: MasterTemplate[] = [];
  for (const row of rows) {
    masters.push({ masterId: row.master_id, name: row.name, active: row.active, archivedReason: row.archived_reason, rowsVersion: row.rows_version,
      version: row.version, updatedBy: row.updated_by, updatedAt: iso(row.updated_at), rows: await readMasterTemplateRows(db, row.master_id, row.rows_version) });
  }
  return masters;
}

/** The admin screen's whole read. */
export async function getMasterTemplatesScreen(db: Queryable): Promise<MasterTemplatesReadModel> {
  return { masters: await listMasterTemplates(db), categories: await listReportingTemplateCategories(db), factors: await listMasterTemplateFactorOptions(db) };
}

// ── Commands ───────────────────────────────────────────────────────────────────────────────────────────────────────

const refuse = (field: string, code: string, message: string) => new CommandValidationError([{ field, code, message }]);
const cleanName = (name: string) => name.trim().replace(/\s+/g, " ");

/** The master as the audit reads it: its name and state, and its lines' shape in counts — never a line's label. */
type MasterSnapshot = { name: string; active: boolean; rowsVersion: number; lineCount: number; byScope: Record<"1" | "2" | "3", number>; withFactor: number };
const snapshot = (header: Pick<HeaderRow, "name" | "active" | "rows_version">, rows: Array<Pick<MasterTemplateRowInput, "scope" | "factorId">>): MasterSnapshot => ({
  name: header.name, active: header.active, rowsVersion: header.rows_version, lineCount: rows.length,
  byScope: { "1": rows.filter((r) => r.scope === "1").length, "2": rows.filter((r) => r.scope === "2").length, "3": rows.filter((r) => r.scope === "3").length },
  withFactor: rows.filter((r) => r.factorId !== null).length,
});
export type MasterTemplateResult = MasterSnapshot & { masterId: string; version: number };

async function lockMaster(db: Queryable, context: CommandContext, masterId: string, expectedVersion: number): Promise<HeaderRow> {
  const { rows: [row] } = await db.query<HeaderRow>(
    `SELECT master_id, name, active, archived_reason, rows_version, version, updated_by, updated_at
       FROM nzi_console.master_templates WHERE organisation_id = $1 AND master_id = $2 FOR UPDATE`, [context.organisationId, masterId]);
  if (!row) throw refuse("masterId", "NOT_FOUND", "That master template is not here.");
  if (row.version !== expectedVersion) throw new VersionConflictError(expectedVersion, row.version);
  return row;
}

const requireActive = (row: HeaderRow) => { if (!row.active) throw refuse("masterId", "ARCHIVED", `Master · ${row.name} is archived — reinstate it to change it.`); };

/** A name belongs to one master in the organisation, archived or not — so a reinstate never collides. */
async function assertNameFree(db: Queryable, context: CommandContext, name: string, exceptId?: string) {
  const { rows: [taken] } = await db.query(
    `SELECT 1 FROM nzi_console.master_templates WHERE organisation_id = $1 AND lower(name) = lower($2) AND master_id IS DISTINCT FROM $3`,
    [context.organisationId, name, exceptId ?? null]);
  if (taken) throw refuse("name", "DUPLICATE", "Another master template — archived or not — already has that name.");
}

/** The unique index is the last word on a name raced past the check: told as the same refusal. */
async function onName<T>(write: Promise<T>): Promise<T> {
  try { return await write; } catch (error) {
    if ((error as { code?: string; constraint?: string }).code === "23505") throw refuse("name", "DUPLICATE", "Another master template — archived or not — already has that name.");
    throw error;
  }
}

const masterRowsOf = async (db: Queryable, header: HeaderRow) => (await readMasterTemplateRows(db, header.master_id, header.rows_version));

export function createMasterTemplate(pool: PoolLike, input: CommandInputMap["master.template.create"], context: CommandContext): Promise<StoredOutcome<MasterTemplateResult>> {
  return runPostgresCommand(pool, "master.template.create", input, context, async (db) => {
    const name = cleanName(input.name);
    await assertNameFree(db, context, name);
    const masterId = `master:${randomUUID()}`;
    await onName(db.query(`INSERT INTO nzi_console.master_templates (organisation_id, master_id, name, created_by, updated_by) VALUES ($1, $2, $3, $4, $4)`,
      [context.organisationId, masterId, name, context.actorId]));
    return {
      data: { masterId, version: 1, ...snapshot({ name, active: true, rows_version: 0 }, []) },
      entityType: "master_template", entityId: masterId, topic: "master_template.created",
    };
  });
}

export function renameMasterTemplate(pool: PoolLike, input: CommandInputMap["master.template.rename"], context: CommandContext): Promise<StoredOutcome<MasterTemplateResult>> {
  return runPostgresCommand(pool, "master.template.rename", input, context, async (db) => {
    const current = await lockMaster(db, context, input.masterId, input.expectedVersion);
    requireActive(current);
    const name = cleanName(input.name);
    if (name === current.name) throw refuse("name", "UNCHANGED", "That is already its name.");
    await assertNameFree(db, context, name, input.masterId);
    const { rows: [saved] } = await onName(db.query<{ version: number }>(
      `UPDATE nzi_console.master_templates SET name = $3, version = version + 1, updated_by = $4, updated_at = now()
        WHERE organisation_id = $1 AND master_id = $2 RETURNING version`, [context.organisationId, input.masterId, name, context.actorId]));
    const rows = await masterRowsOf(db, current);
    return {
      data: { masterId: input.masterId, version: saved!.version, ...snapshot({ ...current, name }, rows) },
      before: snapshot(current, rows), entityType: "master_template", entityId: input.masterId, topic: "master_template.renamed",
    };
  });
}

export function archiveMasterTemplate(pool: PoolLike, input: CommandInputMap["master.template.archive"], context: CommandContext): Promise<StoredOutcome<MasterTemplateResult>> {
  return runPostgresCommand(pool, "master.template.archive", input, context, async (db) => {
    const current = await lockMaster(db, context, input.masterId, input.expectedVersion);
    if (!current.active) throw refuse("masterId", "ALREADY_ARCHIVED", "That master template is already archived.");
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.master_templates SET active = false, archived_reason = $3, version = version + 1, updated_by = $4, updated_at = now()
        WHERE organisation_id = $1 AND master_id = $2 RETURNING version`, [context.organisationId, input.masterId, context.reason!.trim(), context.actorId]);
    const rows = await masterRowsOf(db, current);
    return {
      data: { masterId: input.masterId, version: saved!.version, ...snapshot({ ...current, active: false }, rows) },
      before: snapshot(current, rows), entityType: "master_template", entityId: input.masterId, topic: "master_template.archived",
    };
  });
}

export function reinstateMasterTemplate(pool: PoolLike, input: CommandInputMap["master.template.reinstate"], context: CommandContext): Promise<StoredOutcome<MasterTemplateResult>> {
  return runPostgresCommand(pool, "master.template.reinstate", input, context, async (db) => {
    const current = await lockMaster(db, context, input.masterId, input.expectedVersion);
    if (current.active) throw refuse("masterId", "ALREADY_ACTIVE", "That master template is already active.");
    // No name check: names are unique across active and archived masters alike, so this one's is still its own.
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.master_templates SET active = true, archived_reason = NULL, version = version + 1, updated_by = $3, updated_at = now()
        WHERE organisation_id = $1 AND master_id = $2 RETURNING version`, [context.organisationId, input.masterId, context.actorId]);
    const rows = await masterRowsOf(db, current);
    return {
      data: { masterId: input.masterId, version: saved!.version, ...snapshot({ ...current, active: true }, rows) },
      before: snapshot(current, rows), entityType: "master_template", entityId: input.masterId, topic: "master_template.reinstated",
    };
  });
}

/**
 * Each line's references: a category that exists — active, unless the lines in force already file under it (a retired
 * category still resolves, never newly chosen) — and a factor identity that exists and serves that category.
 */
async function checkRowReferences(db: Queryable, rows: MasterTemplateRowInput[], heldCategories: Set<string>): Promise<void> {
  const categories = new Map((await db.query<{ category_code: string; active: boolean }>(`SELECT category_code, active FROM nzi_console.input_spec_categories`)).rows
    .map((row) => [row.category_code, row.active]));
  const factorIds = [...new Set(rows.flatMap((row) => row.factorId ? [row.factorId.trim()] : []))];
  const factors = new Map((factorIds.length === 0 ? [] : (await db.query<{ factor_id: string; scopes: string[] | null }>(
    `SELECT i.factor_id,
            (SELECT f.scopes FROM nzi_console.emission_factors f JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id, d.dataset_id) = (f.organisation_id, f.dataset_id)
              WHERE (f.organisation_id, f.factor_id) = (i.organisation_id, i.factor_id) AND f.active ORDER BY d.valid_from DESC, d.dataset_id LIMIT 1) AS scopes
       FROM nzi_console.factor_identities i WHERE i.factor_id = ANY($1::text[])`, [factorIds])).rows).map((row) => [row.factor_id, row.scopes ?? []]));
  const issues: Array<{ field: string; code: string; message: string }> = [];
  for (const [index, row] of rows.entries()) {
    const active = categories.get(row.categoryCode);
    if (active === undefined) issues.push({ field: `rows[${index}].categoryCode`, code: "CATEGORY_NOT_FOUND", message: `Line ${index + 1}: that category does not exist.` });
    else if (!active && !heldCategories.has(row.categoryCode)) issues.push({ field: `rows[${index}].categoryCode`, code: "CATEGORY_RETIRED", message: `Line ${index + 1}: that category is retired — choose another.` });
    if (row.factorId) {
      const scopes = factors.get(row.factorId.trim());
      if (scopes === undefined) issues.push({ field: `rows[${index}].factorId`, code: "FACTOR_NOT_FOUND", message: `Line ${index + 1}: that activity's factor was not found.` });
      else if (!masterFactorServes({ scopes }, row)) issues.push({ field: `rows[${index}].factorId`, code: "FACTOR_CATEGORY", message: `Line ${index + 1}: that activity is not one of its category's.` });
    }
    if (issues.length >= 20) break;
  }
  if (issues.length) throw new CommandValidationError(issues);
}

/** Set the master's whole set of lines, as the next rows version. */
export function setMasterTemplateRows(pool: PoolLike, input: CommandInputMap["master.template.rows.set"], context: CommandContext): Promise<StoredOutcome<MasterTemplateResult>> {
  return runPostgresCommand(pool, "master.template.rows.set", input, context, async (db) => {
    const current = await lockMaster(db, context, input.masterId, input.expectedVersion);
    requireActive(current);
    const previous = await masterRowsOf(db, current);
    await checkRowReferences(db, input.rows, new Set(previous.map((row) => row.categoryCode)));
    const rowsVersion = current.rows_version + 1;
    for (const [ordering, row] of input.rows.entries()) {
      await db.query(`INSERT INTO nzi_console.master_template_rows (organisation_id, master_id, rows_version, row_id, scope, category_code, source_label, report_label, factor_id, unit, ordering)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [context.organisationId, input.masterId, rowsVersion, randomUUID(), row.scope, row.categoryCode, row.sourceLabel.trim(), row.reportLabel?.trim() || null,
          row.factorId?.trim() || null, row.unit?.trim() || null, ordering]);
    }
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.master_templates SET rows_version = $3, version = version + 1, updated_by = $4, updated_at = now()
        WHERE organisation_id = $1 AND master_id = $2 RETURNING version`, [context.organisationId, input.masterId, rowsVersion, context.actorId]);
    return {
      data: { masterId: input.masterId, version: saved!.version, ...snapshot({ ...current, rows_version: rowsVersion }, input.rows.map((row) => ({ scope: row.scope, factorId: row.factorId?.trim() || null }))) },
      before: snapshot(current, previous), entityType: "master_template", entityId: input.masterId, topic: "master_template.rows_set",
    };
  });
}
