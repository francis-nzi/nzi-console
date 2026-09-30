import { randomUUID } from "node:crypto";
import {
  fileTypeListSpec, type CommandContext, type CommandInputMap, type FileTypeListFilterKey, type FileTypeListQuery, type FileTypeListSortKey, type ListPage,
} from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import { defineListSql, readListPage } from "./listPage";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";

/**
 * Job file types (admin Phase C3; docs/design/admin-prototype.html → File types; ruled `admin-phaseC-plan.md` Q9).
 * The job file-type vocabulary and its storage folder, added, edited, deactivated and reinstated through the command
 * runner (admin.lookups, idempotency, `expectedVersion`, audit with before and after) — never deleted (R3).
 *
 * - **The key is set once.** It is a create field only; no command updates it, and 0139 grants the application role
 *   no UPDATE on the column, so nothing can.
 * - **A system type is never deactivated** (`SYSTEM_PROTECTED`) — v7's `client_provided` and `generated_report`, which
 *   0139 holds active by a CHECK and which no command can make or unmake (the role cannot write `is_system`).
 * - **Nothing references a type yet**: the console has no job-file store. "In use" is none yet, not zero; a deactivated
 *   type will still resolve on the records that name it once there are any (R3).
 */

// ── The list ───────────────────────────────────────────────────────────────────────────────────────────────────

export type FileTypeProvenance = "v7" | "added" | "seeded";
export type FileTypeRow = {
  fileTypeId: string; key: string; displayName: string; storageFolderKey: string; sortOrder: number;
  active: boolean; isSystem: boolean; version: number; provenance: FileTypeProvenance; updatedAt: string;
  /** Records naming this type — null while nothing references file types (shown "none yet", not 0). */
  inUse: number | null;
};
export type FileTypePage = ListPage<FileTypeRow, FileTypeListFilterKey, Record<string, never>>;

const fileTypeSql = defineListSql<FileTypeListSortKey, FileTypeListFilterKey>({
  base: `SELECT ft.organisation_id, ft.file_type_id, ft.file_type_key AS key, ft.display_name AS name, ft.storage_folder_key, ft.sort_order,
      ft.active, ft.is_system, ft.version, ft.updated_at,
      CASE WHEN ft.active THEN 'active' ELSE 'inactive' END AS status,
      CASE WHEN ft.source_system IS NOT NULL THEN 'v7' WHEN ft.created_by LIKE 'migration:%' THEN 'seeded' ELSE 'added' END AS provenance
    FROM nzi_console.job_file_types ft`,
  search: ["name", "key"],
  filters: { status: { kind: "equals", column: "status", facet: { noneLabel: "—", values: ["active", "inactive"] } } },
  sort: { sortOrder: { column: "sort_order" }, name: { column: "name", text: true }, key: { column: "key", text: true }, status: { column: "status", text: true } },
  tiebreak: "file_type_id",
});

export async function listFileTypesPage(db: Queryable, query: FileTypeListQuery): Promise<FileTypePage> {
  return readListPage(db, fileTypeSql, fileTypeListSpec, query, {
    mapRow: (row) => ({
      fileTypeId: String(row.file_type_id), key: String(row.key), displayName: String(row.name), storageFolderKey: String(row.storage_folder_key),
      sortOrder: Number(row.sort_order), active: row.active === true, isSystem: row.is_system === true, version: Number(row.version),
      provenance: row.provenance as FileTypeProvenance, updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      // Nothing references a file type until the job-file store exists; that workstream adds the count here.
      inUse: null,
    }),
    mapSummary: () => ({}),
  });
}

// ── Commands ───────────────────────────────────────────────────────────────────────────────────────────────────

type StoredFileType = { file_type_key: string; display_name: string; storage_folder_key: string; sort_order: number; active: boolean; is_system: boolean; version: number };
type Snapshot = { key: string; displayName: string; storageFolderKey: string; sortOrder: number; active: boolean; isSystem: boolean };
const snapshot = (row: StoredFileType): Snapshot => ({
  key: row.file_type_key, displayName: row.display_name, storageFolderKey: row.storage_folder_key, sortOrder: row.sort_order, active: row.active, isSystem: row.is_system,
});
/** A command's result is what the type now is — the runner records it as the audit's after_json, beside `before`. */
export type FileTypeResult = Snapshot & { fileTypeId: string; version: number };

const cleanName = (value: string) => value.trim().replace(/\s+/g, " ");

async function lockFileType(db: Queryable, context: CommandContext, fileTypeId: string, expectedVersion: number): Promise<StoredFileType> {
  const { rows: [row] } = await db.query<StoredFileType>(
    `SELECT file_type_key, display_name, storage_folder_key, sort_order, active, is_system, version FROM nzi_console.job_file_types
      WHERE organisation_id = $1 AND file_type_id = $2 FOR UPDATE`, [context.organisationId, fileTypeId]);
  if (!row) throw new CommandValidationError([{ field: "fileTypeId", code: "NOT_FOUND", message: "That file type is not here." }]);
  if (row.version !== expectedVersion) throw new VersionConflictError(expectedVersion, row.version);
  return row;
}

/** A display name belongs to one type, active or not, and a key to one type — 0139's indexes, said as field errors. */
async function assertUnique(db: Queryable, context: CommandContext, fields: { key?: string; displayName: string }, exceptId?: string) {
  const { rows: [taken] } = await db.query<{ name: boolean; key: boolean }>(
    `SELECT coalesce(bool_or(lower(display_name) = lower($2)), false) AS name, coalesce(bool_or($3::text IS NOT NULL AND file_type_key = $3), false) AS key
       FROM nzi_console.job_file_types WHERE organisation_id = $1 AND file_type_id IS DISTINCT FROM $4`,
    [context.organisationId, fields.displayName, fields.key ?? null, exceptId ?? null]);
  const issues = [];
  if (taken?.key) issues.push({ field: "fileTypeKey", code: "DUPLICATE", message: "Another file type already has that key." });
  if (taken?.name) issues.push({ field: "displayName", code: "DUPLICATE", message: "Another file type — active or not — already has that name." });
  if (issues.length) throw new CommandValidationError(issues);
}

export function createFileType(pool: PoolLike, input: CommandInputMap["job_file_type.create"], context: CommandContext): Promise<StoredOutcome<FileTypeResult>> {
  return runPostgresCommand(pool, "job_file_type.create", input, context, async (db) => {
    const key = input.fileTypeKey.trim();
    const displayName = cleanName(input.displayName);
    await assertUnique(db, context, { key, displayName });
    const sortOrder = input.sortOrder ?? Number((await db.query<{ next: string }>(
      `SELECT (coalesce(max(sort_order), 0) + 10)::text AS next FROM nzi_console.job_file_types WHERE organisation_id = $1`, [context.organisationId])).rows[0]!.next);
    const fileTypeId = `file-type:${randomUUID()}`;
    // is_system is not written: 0139 grants the role no INSERT on it, so a type made here is never a system type.
    await db.query(
      `INSERT INTO nzi_console.job_file_types (organisation_id, file_type_id, file_type_key, display_name, storage_folder_key, sort_order, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [context.organisationId, fileTypeId, key, displayName, input.storageFolderKey.trim(), sortOrder, context.actorId]);
    return {
      data: { fileTypeId, version: 1, key, displayName, storageFolderKey: input.storageFolderKey.trim(), sortOrder, active: true, isSystem: false },
      entityType: "job_file_type", entityId: fileTypeId, topic: "job_file_type.created",
    };
  });
}

export function updateFileType(pool: PoolLike, input: CommandInputMap["job_file_type.update"], context: CommandContext): Promise<StoredOutcome<FileTypeResult>> {
  return runPostgresCommand(pool, "job_file_type.update", input, context, async (db) => {
    const current = await lockFileType(db, context, input.fileTypeId, input.expectedVersion);
    const displayName = cleanName(input.displayName);
    await assertUnique(db, context, { displayName }, input.fileTypeId);
    const { rows: [saved] } = await db.query<StoredFileType>(
      `UPDATE nzi_console.job_file_types SET display_name = $3, storage_folder_key = $4, sort_order = $5, version = version + 1, updated_at = now(), updated_by = $6
        WHERE organisation_id = $1 AND file_type_id = $2
        RETURNING file_type_key, display_name, storage_folder_key, sort_order, active, is_system, version`,
      [context.organisationId, input.fileTypeId, displayName, input.storageFolderKey.trim(), input.sortOrder ?? current.sort_order, context.actorId]);
    return {
      data: { fileTypeId: input.fileTypeId, version: saved!.version, ...snapshot(saved!) },
      entityType: "job_file_type", entityId: input.fileTypeId, topic: "job_file_type.updated", before: snapshot(current),
    };
  });
}

export function deactivateFileType(pool: PoolLike, input: CommandInputMap["job_file_type.deactivate"], context: CommandContext): Promise<StoredOutcome<FileTypeResult>> {
  return runPostgresCommand(pool, "job_file_type.deactivate", input, context, async (db) => {
    const current = await lockFileType(db, context, input.fileTypeId, input.expectedVersion);
    if (current.is_system) throw new CommandValidationError([{ field: "fileTypeId", code: "SYSTEM_PROTECTED", message: "A system file type is always available; it cannot be deactivated." }]);
    if (!current.active) throw new CommandValidationError([{ field: "fileTypeId", code: "ALREADY_INACTIVE", message: "That file type is already inactive." }]);
    const { rows: [saved] } = await db.query<StoredFileType>(
      `UPDATE nzi_console.job_file_types SET active = false, version = version + 1, updated_at = now(), updated_by = $3
        WHERE organisation_id = $1 AND file_type_id = $2 RETURNING file_type_key, display_name, storage_folder_key, sort_order, active, is_system, version`,
      [context.organisationId, input.fileTypeId, context.actorId]);
    return {
      data: { fileTypeId: input.fileTypeId, version: saved!.version, ...snapshot(saved!) },
      entityType: "job_file_type", entityId: input.fileTypeId, topic: "job_file_type.deactivated", before: snapshot(current),
    };
  });
}

export function reinstateFileType(pool: PoolLike, input: CommandInputMap["job_file_type.reinstate"], context: CommandContext): Promise<StoredOutcome<FileTypeResult>> {
  return runPostgresCommand(pool, "job_file_type.reinstate", input, context, async (db) => {
    const current = await lockFileType(db, context, input.fileTypeId, input.expectedVersion);
    if (current.active) throw new CommandValidationError([{ field: "fileTypeId", code: "ALREADY_ACTIVE", message: "That file type is already active." }]);
    const { rows: [saved] } = await db.query<StoredFileType>(
      `UPDATE nzi_console.job_file_types SET active = true, version = version + 1, updated_at = now(), updated_by = $3
        WHERE organisation_id = $1 AND file_type_id = $2 RETURNING file_type_key, display_name, storage_folder_key, sort_order, active, is_system, version`,
      [context.organisationId, input.fileTypeId, context.actorId]);
    return {
      data: { fileTypeId: input.fileTypeId, version: saved!.version, ...snapshot(saved!) },
      entityType: "job_file_type", entityId: input.fileTypeId, topic: "job_file_type.reinstated", before: snapshot(current),
    };
  });
}
