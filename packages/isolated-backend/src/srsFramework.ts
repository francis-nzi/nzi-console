// The UK SRS frameworks as an Admin manages them (SRS S1, R1; framework rework, Phase B — 0222).
//
// The frameworks are UK SRS S2 — Climate and UK SRS S1 — General (stored as 0070's standards, `standard_key`). Each is
// locked or unlocked. An unlocked framework is edited in the **working definition** — the organisation's one draft row,
// made on the first unlock as a copy of the snapshot in force and kept from then on. Locking a framework makes the next
// **snapshot** (what 0070 called a version): immutable (0187's triggers), what new assessments bind to, superseding the
// one before. Unlocking reopens a framework; assessments already made stay pinned to their snapshot. Every edit and every
// lock and unlock is stamped in the append-only history. Nothing is deleted; a requirement is retired with `active = false`.
//
// Requirement ids carry over from snapshot to snapshot — the same requirement in a new snapshot — so a strategy's SRS
// alignment, the library's default alignment and a gap's link keep pointing at "S2 M2" as the framework moves.
import { randomUUID } from "node:crypto";
import { todayInLondon, type CommandContext, type CommandInputMap } from "@nzi/contracts";
import type { PoolLike, Queryable } from "./postgres";
import { VersionConflictError } from "./errors";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";

export type SrsFrameworkSnapshot = {
  frameworkId: string; version: number; label: string; status: "draft" | "active" | "superseded";
  effectiveFrom: string | null; notes: string | null; publishedBy: string; publishedAt: string; requirements: number; assessments: number;
};

/** Every snapshot, newest first, with how many requirements it holds and how many assessments were made against it. The working definition is not one. */
export async function listSrsFrameworkSnapshots(db: Queryable): Promise<SrsFrameworkSnapshot[]> {
  const { rows } = await db.query<{
    framework_id: string; version: number; label: string; status: SrsFrameworkSnapshot["status"]; effective_from: string | null; notes: string | null;
    published_by: string; published_at: Date | string; requirements: number; assessments: number;
  }>(
    `SELECT f.framework_id, f.version, f.label, f.status, f.effective_from::text, f.notes, f.published_by, f.published_at,
            (SELECT count(*)::int FROM nzi_console.srs_requirements r WHERE (r.organisation_id, r.framework_id) = (f.organisation_id, f.framework_id) AND r.active) AS requirements,
            (SELECT count(*)::int FROM nzi_console.srs_assessments a WHERE (a.organisation_id, a.framework_id) = (f.organisation_id, f.framework_id)) AS assessments
       FROM nzi_console.srs_frameworks f WHERE f.status <> 'draft' ORDER BY f.version DESC`);
  return rows.map((row) => ({
    frameworkId: row.framework_id, version: row.version, label: row.label, status: row.status, effectiveFrom: row.effective_from, notes: row.notes,
    publishedBy: row.published_by, publishedAt: new Date(row.published_at).toISOString(), requirements: row.requirements, assessments: row.assessments,
  }));
}

export type SrsFrameworkState = {
  key: string; label: string; locked: boolean; changedBy: string; changedByName: string | null; changedAt: string | null;
  /** The snapshot its last lock made (or, unlocked, the one it was reopened from). */
  snapshotVersion: number | null; version: number;
};

/** Each framework of the snapshot in force (and any only in the working definition), with whether it is locked and who last changed that, when. */
export async function listSrsFrameworkStates(db: Queryable): Promise<SrsFrameworkState[]> {
  const { rows } = await db.query<{
    key: string; label: string; ordering: number; locked: boolean | null; changed_by: string | null; changed_by_name: string | null; changed_at: Date | string | null;
    snapshot_version: number | null; version: number | null;
  }>(
    `SELECT DISTINCT ON (s.standard_key) s.standard_key AS key, s.label, s.ordering, l.locked, l.changed_by, m.display_name AS changed_by_name, l.changed_at,
            f.version AS snapshot_version, l.version
       FROM nzi_console.srs_standards s
       JOIN nzi_console.srs_frameworks c ON (c.organisation_id, c.framework_id) = (s.organisation_id, s.framework_id) AND c.status IN ('active', 'draft')
       LEFT JOIN nzi_console.srs_framework_locks l ON (l.organisation_id, l.framework_key) = (s.organisation_id, s.standard_key)
       LEFT JOIN nzi_console.srs_frameworks f ON (f.organisation_id, f.framework_id) = (l.organisation_id, l.snapshot_id)
       LEFT JOIN nzi_console.memberships m ON (m.organisation_id, m.user_id) = (l.organisation_id, l.changed_by)
      ORDER BY s.standard_key, (c.status = 'draft') DESC`);
  return rows.sort((a, b) => a.ordering - b.ordering).map((row) => ({
    key: row.key, label: row.label, locked: row.locked ?? true, changedBy: row.changed_by ?? "", changedByName: row.changed_by_name,
    changedAt: row.changed_at === null ? null : new Date(row.changed_at).toISOString(), snapshotVersion: row.snapshot_version, version: row.version ?? 0,
  }));
}

export type SrsFrameworkHistoryEntry = {
  historyId: string; frameworkKey: string | null; event: string; subject: string | null; snapshotVersion: number | null;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null; actorId: string; actorName: string | null; at: string;
};

/** The history, newest first: every edit and every lock and unlock, who and when. Append-only (0222). */
export async function listSrsFrameworkHistory(db: Queryable, limit = 500): Promise<SrsFrameworkHistoryEntry[]> {
  const { rows } = await db.query<{
    history_id: string; framework_key: string | null; event: string; subject: string | null; snapshot_version: number | null;
    before_json: Record<string, unknown> | null; after_json: Record<string, unknown> | null; actor_id: string; actor_name: string | null; at: Date | string;
  }>(
    `SELECT h.history_id, h.framework_key, h.event, h.subject, h.snapshot_version, h.before_json, h.after_json, h.actor_id, m.display_name AS actor_name, h.at
       FROM nzi_console.srs_framework_history h
       LEFT JOIN nzi_console.memberships m ON (m.organisation_id, m.user_id) = (h.organisation_id, h.actor_id)
      ORDER BY h.at DESC, h.history_id LIMIT $1`, [limit]);
  return rows.map((row) => ({
    historyId: row.history_id, frameworkKey: row.framework_key, event: row.event, subject: row.subject, snapshotVersion: row.snapshot_version,
    before: row.before_json, after: row.after_json, actorId: row.actor_id, actorName: row.actor_name, at: new Date(row.at).toISOString(),
  }));
}

/** The working definition's id, or null before the first unlock. */
export async function srsWorkingDefinitionId(db: Queryable): Promise<string | null> {
  return (await db.query<{ framework_id: string }>(`SELECT framework_id FROM nzi_console.srs_frameworks WHERE status = 'draft'`)).rows[0]?.framework_id ?? null;
}

type History = { frameworkKey: string | null; event: string; subject?: string | null; snapshotId?: string | null; snapshotVersion?: number | null; before?: unknown; after?: unknown };
async function stamp(db: Queryable, context: CommandContext, entry: History): Promise<void> {
  await db.query(
    `INSERT INTO nzi_console.srs_framework_history (organisation_id, history_id, framework_key, event, subject, snapshot_id, snapshot_version, before_json, after_json, actor_id, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
    [context.organisationId, randomUUID(), entry.frameworkKey, entry.event, entry.subject ?? null, entry.snapshotId ?? null, entry.snapshotVersion ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before), entry.after === undefined ? null : JSON.stringify(entry.after), context.actorId, context.correlationId]);
}

/** The lock row, locked for update. A framework with no row has never been unlocked: it reads as locked, version 0. */
async function lockRow(db: Queryable, organisationId: string, frameworkKey: string): Promise<{ locked: boolean; version: number; exists: boolean }> {
  const row = (await db.query<{ locked: boolean; version: number }>(
    `SELECT locked, version FROM nzi_console.srs_framework_locks WHERE organisation_id = $1 AND framework_key = $2 FOR UPDATE`, [organisationId, frameworkKey])).rows[0];
  return row ? { ...row, exists: true } : { locked: true, version: 0, exists: false };
}

async function activeSnapshot(db: Queryable, organisationId: string) {
  return (await db.query<{ framework_id: string; version: number; label: string; notes: string | null }>(
    `SELECT framework_id, version, label, notes FROM nzi_console.srs_frameworks WHERE organisation_id = $1 AND status = 'active' FOR UPDATE`, [organisationId])).rows[0] ?? null;
}

/** The working definition, locked — refused before the first unlock. */
async function workingDefinition(db: Queryable, organisationId: string): Promise<{ frameworkId: string; version: number }> {
  const row = (await db.query<{ framework_id: string; version: number }>(
    `SELECT framework_id, version FROM nzi_console.srs_frameworks WHERE organisation_id = $1 AND status = 'draft' FOR UPDATE`, [organisationId])).rows[0];
  if (!row) throw new CommandValidationError([{ field: "frameworkKey", code: "LOCKED", message: "Every framework is locked — unlock one to edit it." }]);
  return { frameworkId: row.framework_id, version: row.version };
}

/** Refused unless every framework is unlocked: pillars and the ladder are shared, so changing one would change a locked framework. */
async function requireAllUnlocked(db: Queryable, organisationId: string, workingId: string): Promise<void> {
  const locked = (await db.query<{ label: string }>(
    `SELECT s.label FROM nzi_console.srs_standards s
       LEFT JOIN nzi_console.srs_framework_locks l ON (l.organisation_id, l.framework_key) = (s.organisation_id, s.standard_key)
      WHERE s.organisation_id = $1 AND s.framework_id = $2 AND coalesce(l.locked, true) ORDER BY s.ordering`, [organisationId, workingId])).rows;
  if (locked.length > 0) {
    throw new CommandValidationError([{ field: "frameworkKey", code: "SHARED_LOCKED",
      message: `Pillars and the ladder are shared by every framework — unlock ${locked.map((row) => row.label).join(" and ")} to change them.` }]);
  }
}

/** Copy one framework definition into another — standards, pillars, ladder and requirements — optionally only some frameworks' requirements. */
async function copyDefinition(db: Queryable, organisationId: string, toId: string, fromId: string, only?: { frameworkKeys: string[]; include: boolean }): Promise<number> {
  const params = [organisationId, toId, fromId];
  const filter = only ? ` AND ${only.include ? "" : "NOT "}(standard_key = ANY($4::text[]))` : "";
  const extra = only ? [only.frameworkKeys] : [];
  await db.query(`INSERT INTO nzi_console.srs_standards (organisation_id, framework_id, standard_key, label, description, climate_led, ordering)
    SELECT organisation_id, $2, standard_key, label, description, climate_led, ordering FROM nzi_console.srs_standards WHERE organisation_id = $1 AND framework_id = $3${filter}
    ON CONFLICT DO NOTHING`, [...params, ...extra]);
  if (!only || !only.include) {
    await db.query(`INSERT INTO nzi_console.srs_pillars (organisation_id, framework_id, pillar_key, label, description, ordering)
      SELECT organisation_id, $2, pillar_key, label, description, ordering FROM nzi_console.srs_pillars WHERE organisation_id = $1 AND framework_id = $3`, params);
    await db.query(`INSERT INTO nzi_console.srs_maturity_levels (organisation_id, framework_id, level, key, label, definition)
      SELECT organisation_id, $2, level, key, label, definition FROM nzi_console.srs_maturity_levels WHERE organisation_id = $1 AND framework_id = $3`, params);
  }
  const copied = await db.query(`INSERT INTO nzi_console.srs_requirements
      (organisation_id, framework_id, requirement_id, standard_key, pillar_key, code, title, help_text, weight, source, nzi_source_key, target_maturity, ordering, active)
    SELECT organisation_id, $2, requirement_id, standard_key, pillar_key, code, title, help_text, weight, source, nzi_source_key, target_maturity, ordering, active
      FROM nzi_console.srs_requirements WHERE organisation_id = $1 AND framework_id = $3${filter} RETURNING requirement_id`, [...params, ...extra]);
  return copied.rows.length;
}

export type UnlockSrsFrameworkResult = { frameworkKey: string; version: number; workingDefinitionId: string; reopenedFrom: number | null; assessmentsPinned: number };

/**
 * Unlock a framework: it becomes editable in the working definition, made on the first unlock as a copy of the snapshot
 * in force. Nothing already assessed moves — the count of assessments pinned to their snapshots is returned for the warning.
 */
export function unlockSrsFramework(pool: PoolLike, input: CommandInputMap["srs.framework.unlock"], context: CommandContext): Promise<StoredOutcome<UnlockSrsFrameworkResult>> {
  return runPostgresCommand<"srs.framework.unlock", UnlockSrsFrameworkResult>(pool, "srs.framework.unlock", input, context, async (db) => {
    const org = context.organisationId;
    const active = await activeSnapshot(db, org);
    if (!active) throw new CommandValidationError([{ field: "frameworkKey", code: "NO_FRAMEWORK", message: "No framework is in force to unlock." }]);
    const known = (await db.query(`SELECT 1 FROM nzi_console.srs_standards WHERE organisation_id = $1 AND framework_id = $2 AND standard_key = $3`, [org, active.framework_id, input.frameworkKey])).rows[0];
    if (!known) throw new CommandValidationError([{ field: "frameworkKey", code: "NOT_FOUND", message: "That framework is not in the snapshot in force." }]);
    const lock = await lockRow(db, org, input.frameworkKey);
    if (lock.version !== input.expectedVersion) throw new VersionConflictError();
    if (!lock.locked) throw new CommandValidationError([{ field: "frameworkKey", code: "UNLOCKED", message: "That framework is already unlocked." }]);

    let workingId = (await db.query<{ framework_id: string }>(`SELECT framework_id FROM nzi_console.srs_frameworks WHERE organisation_id = $1 AND status = 'draft' FOR UPDATE`, [org])).rows[0]?.framework_id ?? null;
    if (!workingId) {
      workingId = `srs-working-${randomUUID().slice(0, 8)}`;
      await db.query(`INSERT INTO nzi_console.srs_frameworks (organisation_id, framework_id, version, label, status, notes, published_by) VALUES ($1, $2, $3, $4, 'draft', $5, $6)`,
        [org, workingId, active.version + 1, active.label, active.notes, context.actorId]);
      await copyDefinition(db, org, workingId, active.framework_id);
    }
    const version = lock.version + 1;
    await db.query(
      `INSERT INTO nzi_console.srs_framework_locks (organisation_id, framework_key, locked, changed_by, changed_at, snapshot_id, version) VALUES ($1, $2, false, $3, now(), $4, $5)
       ON CONFLICT (organisation_id, framework_key) DO UPDATE SET locked = false, changed_by = $3, changed_at = now(), snapshot_id = $4, version = $5`,
      [org, input.frameworkKey, context.actorId, active.framework_id, version]);
    const assessmentsPinned = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM nzi_console.srs_assessments WHERE organisation_id = $1`, [org])).rows[0]!.n;
    await stamp(db, context, { frameworkKey: input.frameworkKey, event: "unlocked", snapshotId: active.framework_id, snapshotVersion: active.version, after: { assessmentsPinned } });
    return {
      data: { frameworkKey: input.frameworkKey, version, workingDefinitionId: workingId, reopenedFrom: active.version, assessmentsPinned },
      entityType: "srs_framework", entityId: input.frameworkKey, topic: "srs.framework.unlocked",
      before: { locked: true, version: lock.version },
    };
  });
}

export type LockSrsFrameworkResult = { frameworkKey: string; version: number; snapshotId: string; snapshotVersion: number; superseded: string | null; requirements: number; libraryAlignmentsCarried: number };

/**
 * Lock a framework: the next snapshot is made — this framework and every other locked one as the working definition holds
 * them, each framework still unlocked as its last snapshot held it — and supersedes the snapshot in force, which is kept,
 * readable, and still what its assessments were made against. The library's default SRS alignment is carried to the new
 * snapshot for every requirement it still holds, so "Add from library" keeps pre-filling what a strategy advances.
 */
export function lockSrsFramework(pool: PoolLike, input: CommandInputMap["srs.framework.lock"], context: CommandContext): Promise<StoredOutcome<LockSrsFrameworkResult>> {
  return runPostgresCommand<"srs.framework.lock", LockSrsFrameworkResult>(pool, "srs.framework.lock", input, context, async (db) => {
    const org = context.organisationId;
    const lock = await lockRow(db, org, input.frameworkKey);
    if (lock.version !== input.expectedVersion) throw new VersionConflictError();
    if (lock.locked) throw new CommandValidationError([{ field: "frameworkKey", code: "LOCKED", message: "That framework is already locked." }]);
    const working = await workingDefinition(db, org);
    const active = await activeSnapshot(db, org);
    const requirements = (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM nzi_console.srs_requirements WHERE organisation_id = $1 AND framework_id = $2 AND standard_key = $3 AND active`,
      [org, working.frameworkId, input.frameworkKey])).rows[0]!.n;
    if (requirements === 0) throw new CommandValidationError([{ field: "frameworkKey", code: "EMPTY", message: "A framework with no active requirements cannot be locked." }]);

    // Every other framework still unlocked goes into the snapshot as its last snapshot held it, not half-edited.
    const stillUnlocked = (await db.query<{ framework_key: string }>(
      `SELECT framework_key FROM nzi_console.srs_framework_locks WHERE organisation_id = $1 AND NOT locked AND framework_key <> $2`, [org, input.frameworkKey])).rows.map((row) => row.framework_key);
    const snapshotVersion = (await db.query<{ next: number }>(
      `SELECT coalesce(max(version), 0) + 1 AS next FROM nzi_console.srs_frameworks WHERE organisation_id = $1 AND status <> 'draft'`, [org])).rows[0]!.next;
    const snapshotId = `srs-v${snapshotVersion}-${randomUUID().slice(0, 8)}`;
    if (active) await db.query(`UPDATE nzi_console.srs_frameworks SET status = 'superseded' WHERE organisation_id = $1 AND framework_id = $2`, [org, active.framework_id]);
    await db.query(
      `INSERT INTO nzi_console.srs_frameworks (organisation_id, framework_id, version, label, status, effective_from, notes, published_by)
       SELECT organisation_id, $2, $3, label, 'active', $4, notes, $5 FROM nzi_console.srs_frameworks WHERE organisation_id = $1 AND framework_id = $6`,
      [org, snapshotId, snapshotVersion, todayInLondon(), context.actorId, active?.framework_id ?? working.frameworkId]);
    await copyDefinition(db, org, snapshotId, working.frameworkId, { frameworkKeys: stillUnlocked, include: false });
    if (active && stillUnlocked.length > 0) await copyDefinition(db, org, snapshotId, active.framework_id, { frameworkKeys: stillUnlocked, include: true });
    await db.query(`UPDATE nzi_console.srs_frameworks SET version = $3 WHERE organisation_id = $1 AND framework_id = $2`, [org, working.frameworkId, snapshotVersion + 1]);

    const carried = active ? await db.query(
      `INSERT INTO nzi_console.strategy_srs_requirements (organisation_id, strategy_id, framework_id, requirement_id)
       SELECT s.organisation_id, s.strategy_id, $2, s.requirement_id FROM nzi_console.strategy_srs_requirements s
         JOIN nzi_console.srs_requirements r ON (r.organisation_id, r.framework_id, r.requirement_id) = (s.organisation_id, $2, s.requirement_id) AND r.active
        WHERE s.organisation_id = $1 AND s.framework_id = $3
       ON CONFLICT DO NOTHING RETURNING strategy_id`, [org, snapshotId, active.framework_id]) : { rows: [] };

    const version = lock.version + 1;
    await db.query(`UPDATE nzi_console.srs_framework_locks SET locked = true, changed_by = $3, changed_at = now(), snapshot_id = $4, version = $5 WHERE organisation_id = $1 AND framework_key = $2`,
      [org, input.frameworkKey, context.actorId, snapshotId, version]);
    await stamp(db, context, { frameworkKey: input.frameworkKey, event: "locked", snapshotId, snapshotVersion, after: { requirements, superseded: active?.framework_id ?? null } });
    return {
      data: { frameworkKey: input.frameworkKey, version, snapshotId, snapshotVersion, superseded: active?.framework_id ?? null, requirements, libraryAlignmentsCarried: carried.rows.length },
      entityType: "srs_framework", entityId: input.frameworkKey, topic: "srs.framework.locked",
      before: { locked: false, version: lock.version, inForce: active?.framework_id ?? null },
    };
  });
}

export type UpsertSrsRequirementResult = { frameworkKey: string; requirementId: string; created: boolean; code: string; weight: number; targetMaturity: number; active: boolean };

/** Add a requirement to an unlocked framework, or change one. Its framework, pillar and code are fixed once added. */
export function upsertSrsRequirement(pool: PoolLike, input: CommandInputMap["srs.framework.requirement.upsert"], context: CommandContext): Promise<StoredOutcome<UpsertSrsRequirementResult>> {
  return runPostgresCommand<"srs.framework.requirement.upsert", UpsertSrsRequirementResult>(pool, "srs.framework.requirement.upsert", input, context, async (db) => {
    const org = context.organisationId;
    const working = await workingDefinition(db, org);
    const lock = await lockRow(db, org, input.frameworkKey);
    if (lock.locked) throw new CommandValidationError([{ field: "frameworkKey", code: "LOCKED", message: "That framework is locked — unlock it to edit it." }]);
    const frameworkId = working.frameworkId;
    const code = input.code.trim();
    const fields = { title: input.title.trim(), help: input.helpText?.trim() ?? "", weight: input.weight, target: input.targetMaturity, active: input.active };
    if (input.requirementId) {
      const current = (await db.query<{ code: string; standard_key: string; pillar_key: string; weight: string; target_maturity: number; active: boolean; title: string; help_text: string; ordering: number }>(
        `SELECT code, standard_key, pillar_key, weight::text, target_maturity, active, title, help_text, ordering FROM nzi_console.srs_requirements
          WHERE organisation_id = $1 AND framework_id = $2 AND requirement_id = $3 FOR UPDATE`, [org, frameworkId, input.requirementId])).rows[0];
      if (!current) throw new CommandValidationError([{ field: "requirementId", code: "NOT_FOUND", message: "That requirement is not in the working definition." }]);
      if (current.code !== code || current.standard_key !== input.frameworkKey || current.pillar_key !== input.pillarKey) {
        throw new CommandValidationError([{ field: "code", code: "FIXED", message: "A requirement's code, framework and pillar are fixed — retire it and add a new one instead." }]);
      }
      await db.query(
        `UPDATE nzi_console.srs_requirements SET title = $4, help_text = $5, weight = $6, target_maturity = $7, active = $8, ordering = $9
          WHERE organisation_id = $1 AND framework_id = $2 AND requirement_id = $3`,
        [org, frameworkId, input.requirementId, fields.title, fields.help, fields.weight, fields.target, fields.active, input.ordering ?? current.ordering]);
      const before = { title: current.title, helpText: current.help_text, weight: Number(current.weight), targetMaturity: current.target_maturity, active: current.active };
      const after = { title: fields.title, helpText: fields.help, weight: fields.weight, targetMaturity: fields.target, active: fields.active };
      const event = current.active && !fields.active ? "requirement_retired" : !current.active && fields.active ? "requirement_restored" : "requirement_edited";
      await stamp(db, context, { frameworkKey: input.frameworkKey, event, subject: input.requirementId, before, after: { code, ...after } });
      return {
        data: { frameworkKey: input.frameworkKey, requirementId: input.requirementId, created: false, code, weight: fields.weight, targetMaturity: fields.target, active: fields.active },
        entityType: "srs_requirement", entityId: `${frameworkId}:${input.requirementId}`, topic: "srs.framework.requirement_upserted", before,
      };
    }
    const known = (await db.query<{ framework: boolean; pillar: boolean; clash: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM nzi_console.srs_standards WHERE organisation_id = $1 AND framework_id = $2 AND standard_key = $3) AS framework,
              EXISTS (SELECT 1 FROM nzi_console.srs_pillars WHERE organisation_id = $1 AND framework_id = $2 AND pillar_key = $4) AS pillar,
              EXISTS (SELECT 1 FROM nzi_console.srs_requirements WHERE organisation_id = $1 AND framework_id = $2 AND lower(code) = lower($5)) AS clash`,
      [org, frameworkId, input.frameworkKey, input.pillarKey, code])).rows[0]!;
    if (!known.framework) throw new CommandValidationError([{ field: "frameworkKey", code: "NOT_FOUND", message: "That framework is not in the working definition." }]);
    if (!known.pillar) throw new CommandValidationError([{ field: "pillarKey", code: "NOT_FOUND", message: "That pillar is not in the working definition." }]);
    if (known.clash) throw new CommandValidationError([{ field: "code", code: "DUPLICATE", message: "A requirement with that code is already in the working definition." }]);
    const requirementId = `req-${randomUUID()}`;
    const ordering = input.ordering ?? (await db.query<{ next: number }>(
      `SELECT coalesce(max(ordering), 0) + 1 AS next FROM nzi_console.srs_requirements WHERE organisation_id = $1 AND framework_id = $2 AND standard_key = $3 AND pillar_key = $4`,
      [org, frameworkId, input.frameworkKey, input.pillarKey])).rows[0]!.next;
    await db.query(
      `INSERT INTO nzi_console.srs_requirements (organisation_id, framework_id, requirement_id, standard_key, pillar_key, code, title, help_text, weight, source, target_maturity, ordering, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'entered', $10, $11, $12)`,
      [org, frameworkId, requirementId, input.frameworkKey, input.pillarKey, code, fields.title, fields.help, fields.weight, fields.target, ordering, fields.active]);
    await stamp(db, context, { frameworkKey: input.frameworkKey, event: "requirement_added", subject: requirementId,
      after: { code, pillarKey: input.pillarKey, title: fields.title, helpText: fields.help, weight: fields.weight, targetMaturity: fields.target, active: fields.active } });
    return {
      data: { frameworkKey: input.frameworkKey, requirementId, created: true, code, weight: fields.weight, targetMaturity: fields.target, active: fields.active },
      entityType: "srs_requirement", entityId: `${frameworkId}:${requirementId}`, topic: "srs.framework.requirement_upserted",
    };
  });
}

export type UpsertSrsPillarResult = { pillarKey: string; label: string; created: boolean };

const pillarKeyFrom = (label: string) => label.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "pillar";

/** Add a pillar, or rename one. Pillars are shared by every framework, so every framework must be unlocked. */
export function upsertSrsPillar(pool: PoolLike, input: CommandInputMap["srs.framework.pillar.upsert"], context: CommandContext): Promise<StoredOutcome<UpsertSrsPillarResult>> {
  return runPostgresCommand<"srs.framework.pillar.upsert", UpsertSrsPillarResult>(pool, "srs.framework.pillar.upsert", input, context, async (db) => {
    const org = context.organisationId;
    const working = await workingDefinition(db, org);
    await requireAllUnlocked(db, org, working.frameworkId);
    const label = input.label.trim();
    const description = input.description?.trim() ?? "";
    if (input.pillarKey) {
      const current = (await db.query<{ label: string; description: string }>(
        `SELECT label, description FROM nzi_console.srs_pillars WHERE organisation_id = $1 AND framework_id = $2 AND pillar_key = $3 FOR UPDATE`,
        [org, working.frameworkId, input.pillarKey])).rows[0];
      if (!current) throw new CommandValidationError([{ field: "pillarKey", code: "NOT_FOUND", message: "That pillar is not in the working definition." }]);
      await db.query(`UPDATE nzi_console.srs_pillars SET label = $4, description = $5 WHERE organisation_id = $1 AND framework_id = $2 AND pillar_key = $3`,
        [org, working.frameworkId, input.pillarKey, label, description]);
      await stamp(db, context, { frameworkKey: null, event: "pillar_renamed", subject: input.pillarKey, before: current, after: { label, description } });
      return { data: { pillarKey: input.pillarKey, label, created: false }, entityType: "srs_pillar", entityId: `${working.frameworkId}:${input.pillarKey}`, topic: "srs.framework.pillar_upserted", before: current };
    }
    const clash = (await db.query(`SELECT 1 FROM nzi_console.srs_pillars WHERE organisation_id = $1 AND framework_id = $2 AND (lower(label) = lower($3) OR pillar_key = $4)`,
      [org, working.frameworkId, label, pillarKeyFrom(label)])).rows[0];
    if (clash) throw new CommandValidationError([{ field: "label", code: "DUPLICATE", message: "A pillar with that name is already in the working definition." }]);
    const pillarKey = pillarKeyFrom(label);
    await db.query(
      `INSERT INTO nzi_console.srs_pillars (organisation_id, framework_id, pillar_key, label, description, ordering)
       SELECT $1, $2, $3, $4, $5, coalesce(max(ordering), 0) + 1 FROM nzi_console.srs_pillars WHERE organisation_id = $1 AND framework_id = $2`,
      [org, working.frameworkId, pillarKey, label, description]);
    await stamp(db, context, { frameworkKey: null, event: "pillar_added", subject: pillarKey, after: { label, description } });
    return { data: { pillarKey, label, created: true }, entityType: "srs_pillar", entityId: `${working.frameworkId}:${pillarKey}`, topic: "srs.framework.pillar_upserted" };
  });
}

export type UpdateSrsMaturityResult = { level: number; label: string };

/** Reword a step of the ladder. The five steps (0–4) are fixed (R5); the ladder is shared, so every framework must be unlocked. */
export function updateSrsMaturityLevel(pool: PoolLike, input: CommandInputMap["srs.framework.maturity.update"], context: CommandContext): Promise<StoredOutcome<UpdateSrsMaturityResult>> {
  return runPostgresCommand<"srs.framework.maturity.update", UpdateSrsMaturityResult>(pool, "srs.framework.maturity.update", input, context, async (db) => {
    const org = context.organisationId;
    const working = await workingDefinition(db, org);
    await requireAllUnlocked(db, org, working.frameworkId);
    const current = (await db.query<{ label: string; definition: string }>(
      `SELECT label, definition FROM nzi_console.srs_maturity_levels WHERE organisation_id = $1 AND framework_id = $2 AND level = $3 FOR UPDATE`,
      [org, working.frameworkId, input.level])).rows[0];
    if (!current) throw new CommandValidationError([{ field: "level", code: "NOT_FOUND", message: "That step is not on the ladder." }]);
    const after = { label: input.label.trim(), definition: input.definition.trim() };
    await db.query(`UPDATE nzi_console.srs_maturity_levels SET label = $4, definition = $5 WHERE organisation_id = $1 AND framework_id = $2 AND level = $3`,
      [org, working.frameworkId, input.level, after.label, after.definition]);
    await stamp(db, context, { frameworkKey: null, event: "ladder_reworded", subject: String(input.level), before: current, after });
    return {
      data: { level: input.level, label: after.label },
      entityType: "srs_maturity_level", entityId: `${working.frameworkId}:${input.level}`, topic: "srs.framework.maturity_updated",
      before: current,
    };
  });
}
