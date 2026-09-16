import { randomUUID } from "node:crypto";
import {
  knowledgeKey, transitionRefusal,
  type CommandContext, type CommandInputMap, type KnowledgeStatus,
} from "@nzi/contracts";
import { recordKnowledgeVersion } from "./knowledgeRecords";
export { findSimilarKnowledge, getKnowledgeEntry, listKnowledgeEntries, listKnowledgeQueue, listKnowledgeVersions } from "./knowledgeRecords";
import { VersionConflictError } from "./errors";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";

/**
 * Writing to the knowledge library.
 *
 * Every command here is permission-checked, audited, optimistic-concurrency guarded and
 * append-only in its history. The two that matter most are the tiers: `approve` makes an
 * entry citable by the help AI, `publish` makes it client-facing, and nothing reaches the
 * second without having passed the first.
 */

export type KnowledgeResult = { entryId: string; version: number; status: KnowledgeStatus };

type LockedEntry = {
  entry_id: string; version: number; status: string; active: boolean;
  canonical_question: string; canonical_key: string;
};

async function lockEntry(db: Queryable, context: CommandContext, entryId: string, expectedVersion: number): Promise<LockedEntry> {
  const found = await db.query<LockedEntry>(
    `SELECT entry_id, version, status, active, canonical_question, canonical_key
     FROM nzi_console.knowledge_entries
     WHERE organisation_id=$1 AND entry_id=$2 FOR UPDATE`,
    [context.organisationId, entryId]);
  const row = found.rows[0];
  if (!row) throw new CommandValidationError([{ field: "entryId", code: "NOT_FOUND", message: "That library entry does not exist." }]);
  // Refused and rebased, never clobbered: the caller re-reads and decides again.
  if (row.version !== expectedVersion) throw new VersionConflictError(expectedVersion, row.version);
  if (!row.active) throw new CommandValidationError([{ field: "entryId", code: "INACTIVE", message: "That entry has been withdrawn from the library." }]);
  return row;
}

/**
 * Capture — idempotent by construction.
 *
 * A second capture of the same answer by the same person **returns their existing draft**
 * rather than failing or creating a rival. That is why the partial unique index exists: the
 * guarantee is the database's, not this function remembering to look first.
 */
export function captureKnowledge(pool: PoolLike, input: CommandInputMap["knowledge.capture"], context: CommandContext): Promise<StoredOutcome<KnowledgeResult>> {
  return runPostgresCommand(pool, "knowledge.capture", input, context, async (db) => {
    const question = input.question.trim();
    const key = knowledgeKey(question);
    if (key === "") {
      throw new CommandValidationError([{ field: "question", code: "INVALID", message: "A question needs some words in it." }]);
    }

    const existing = await db.query<{ entry_id: string; version: number; status: string }>(
      `SELECT entry_id, version, status FROM nzi_console.knowledge_entries
       WHERE organisation_id=$1 AND created_by=$2 AND source_key=$3 AND status='draft' AND active`,
      [context.organisationId, context.actorId, input.sourceKey]);
    const open = existing.rows[0];
    if (open) {
      // Reopened, not duplicated. Returned as a success so a second click is a no-op rather
      // than an error the person has to interpret.
      return {
        data: { entryId: open.entry_id, version: open.version, status: open.status as KnowledgeStatus },
        entityType: "knowledge_entry", entityId: open.entry_id, topic: "knowledge.capture.reopened",
      };
    }

    if (input.revisesEntryId) {
      const target = await db.query<{ status: string }>(
        `SELECT status FROM nzi_console.knowledge_entries WHERE organisation_id=$1 AND entry_id=$2 AND active`,
        [context.organisationId, input.revisesEntryId]);
      if (!target.rows[0]) throw new CommandValidationError([{ field: "revisesEntryId", code: "NOT_FOUND", message: "The entry being revised does not exist." }]);
      if (target.rows[0].status === "draft") {
        throw new CommandValidationError([{ field: "revisesEntryId", code: "INVALID", message: "That entry is still a draft — edit it directly rather than revising it." }]);
      }
    }

    const entryId = `knowledge-${randomUUID()}`;
    await db.query(
      `INSERT INTO nzi_console.knowledge_entries
         (organisation_id, entry_id, canonical_question, canonical_key, answer, status, category, area,
          source_key, asked_by, drafted_by, drafted_by_kind, possible_duplicate, revises_entry_id,
          created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,
      [context.organisationId, entryId, question, key, input.answer.trim(), input.category?.trim() ?? "", input.area?.trim() ?? "",
        input.sourceKey, input.askedBy?.trim() ?? "", context.actorId, input.draftedByKind ?? "human",
        input.possibleDuplicate ?? false, input.revisesEntryId ?? null, context.actorId]);
    await recordKnowledgeVersion(db, { organisationId: context.organisationId, entryId, version: 1, change: "captured", changedBy: context.actorId, correlationId: context.correlationId });

    return {
      data: { entryId, version: 1, status: "draft" },
      entityType: "knowledge_entry", entityId: entryId, topic: "knowledge.captured",
      after: { question, draftedByKind: input.draftedByKind ?? "human", possibleDuplicate: input.possibleDuplicate ?? false },
    };
  });
}

/** Fold a rephrasing in, so a re-ask finds the answer instead of creating a rival. */
export function addKnowledgeAlias(pool: PoolLike, input: CommandInputMap["knowledge.alias.add"], context: CommandContext): Promise<StoredOutcome<KnowledgeResult>> {
  return runPostgresCommand(pool, "knowledge.alias.add", input, context, async (db) => {
    const entry = await lockEntry(db, context, input.entryId, input.expectedVersion);
    const question = input.question.trim();
    const key = knowledgeKey(question);
    if (key === "" || key === entry.canonical_key) {
      throw new CommandValidationError([{ field: "question", code: "INVALID", message: "That is the entry's own question, so there is nothing to add." }]);
    }
    await db.query(
      `INSERT INTO nzi_console.knowledge_entry_aliases (organisation_id, entry_id, alias_key, alias_question, added_by)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [context.organisationId, input.entryId, key, question, context.actorId]);
    return {
      data: { entryId: entry.entry_id, version: entry.version, status: entry.status as KnowledgeStatus },
      entityType: "knowledge_entry", entityId: entry.entry_id, topic: "knowledge.alias.added",
      after: { alias: question },
    };
  });
}

/** Edit the text. On an approved entry this is the approver's own correction. */
export function editKnowledge(pool: PoolLike, input: CommandInputMap["knowledge.edit"], context: CommandContext): Promise<StoredOutcome<KnowledgeResult>> {
  return runPostgresCommand(pool, "knowledge.edit", input, context, async (db) => {
    const entry = await lockEntry(db, context, input.entryId, input.expectedVersion);
    const question = input.question.trim();
    const saved = await updateEntry(db, context, input.entryId, input.expectedVersion,
      `canonical_question=$4, canonical_key=$5, answer=$6, category=$7, area=$8`,
      [question, knowledgeKey(question), input.answer.trim(), input.category?.trim() ?? "", input.area?.trim() ?? ""]);
    await recordKnowledgeVersion(db, { organisationId: context.organisationId, entryId: input.entryId, version: saved, change: "edited", changedBy: context.actorId, correlationId: context.correlationId });
    return {
      data: { entryId: input.entryId, version: saved, status: entry.status as KnowledgeStatus },
      entityType: "knowledge_entry", entityId: input.entryId, topic: "knowledge.edited",
      before: { question: entry.canonical_question }, after: { question },
    };
  });
}

/**
 * draft → internal. The entry becomes live for staff and citable by the help AI.
 *
 * Where the draft was a revision of an approved entry, its text replaces the target's and
 * the revision closes — the live answer is only ever swapped once a person has ratified the
 * replacement, so grounding never has a gap.
 */
export function approveKnowledge(pool: PoolLike, input: CommandInputMap["knowledge.approve"], context: CommandContext): Promise<StoredOutcome<KnowledgeResult>> {
  return runPostgresCommand(pool, "knowledge.approve", input, context, async (db) => {
    const entry = await lockEntry(db, context, input.entryId, input.expectedVersion);
    refuseTransition(entry.status, "approve");

    const revises = await db.query<{ revises_entry_id: string | null; answer: string; canonical_question: string; category: string; area: string }>(
      `SELECT revises_entry_id, answer, canonical_question, category, area FROM nzi_console.knowledge_entries
       WHERE organisation_id=$1 AND entry_id=$2`, [context.organisationId, input.entryId]);
    const revisesEntryId = revises.rows[0]?.revises_entry_id ?? null;

    if (revisesEntryId !== null) {
      const source = revises.rows[0]!;
      const target = await db.query<{ version: number }>(
        `UPDATE nzi_console.knowledge_entries
         SET canonical_question=$3, canonical_key=$4, answer=$5, category=$6, area=$7,
             version=version+1, updated_by=$8, updated_at=now()
         WHERE organisation_id=$1 AND entry_id=$2 RETURNING version`,
        [context.organisationId, revisesEntryId, source.canonical_question, knowledgeKey(source.canonical_question),
          source.answer, source.category, source.area, context.actorId]);
      await recordKnowledgeVersion(db, { organisationId: context.organisationId, entryId: revisesEntryId, version: target.rows[0]!.version, change: "revision-applied", changedBy: context.actorId, correlationId: context.correlationId });
      const closed = await closeEntry(db, context, input.entryId, input.expectedVersion, null);
      await recordKnowledgeVersion(db, { organisationId: context.organisationId, entryId: input.entryId, version: closed, change: "approved", changedBy: context.actorId, correlationId: context.correlationId });
      return {
        data: { entryId: revisesEntryId, version: target.rows[0]!.version, status: "internal" },
        entityType: "knowledge_entry", entityId: revisesEntryId, topic: "knowledge.revision.applied",
        after: { revisionOf: revisesEntryId },
      };
    }

    const saved = await updateEntry(db, context, input.entryId, input.expectedVersion,
      `status='internal', approved_by=$4, approved_at=now(), possible_duplicate=false`, [context.actorId]);
    await recordKnowledgeVersion(db, { organisationId: context.organisationId, entryId: input.entryId, version: saved, change: "approved", changedBy: context.actorId, correlationId: context.correlationId });
    return {
      data: { entryId: input.entryId, version: saved, status: "internal" },
      entityType: "knowledge_entry", entityId: input.entryId, topic: "knowledge.approved",
      before: { status: entry.status }, after: { status: "internal" },
    };
  });
}

/** internal → public. Client-facing and website-bound; Admin only, by the matrix. */
export function publishKnowledge(pool: PoolLike, input: CommandInputMap["knowledge.publish"], context: CommandContext): Promise<StoredOutcome<KnowledgeResult>> {
  return runPostgresCommand(pool, "knowledge.publish", input, context, async (db) => {
    const entry = await lockEntry(db, context, input.entryId, input.expectedVersion);
    refuseTransition(entry.status, "publish");
    const saved = await updateEntry(db, context, input.entryId, input.expectedVersion,
      `status='public', published_by=$4, published_at=now()`, [context.actorId]);
    await recordKnowledgeVersion(db, { organisationId: context.organisationId, entryId: input.entryId, version: saved, change: "published", changedBy: context.actorId, correlationId: context.correlationId });
    return {
      data: { entryId: input.entryId, version: saved, status: "public" },
      entityType: "knowledge_entry", entityId: input.entryId, topic: "knowledge.published",
      before: { status: entry.status }, after: { status: "public" },
    };
  });
}

/** Rejected, never deleted — including what it duplicated, where that was the reason. */
export function rejectKnowledge(pool: PoolLike, input: CommandInputMap["knowledge.reject"], context: CommandContext): Promise<StoredOutcome<KnowledgeResult>> {
  return runPostgresCommand(pool, "knowledge.reject", input, context, async (db) => {
    const entry = await lockEntry(db, context, input.entryId, input.expectedVersion);
    const saved = await closeEntry(db, context, input.entryId, input.expectedVersion, input.duplicateOfEntryId ?? null);
    await recordKnowledgeVersion(db, { organisationId: context.organisationId, entryId: input.entryId, version: saved, change: "rejected", changedBy: context.actorId, correlationId: context.correlationId });
    return {
      data: { entryId: input.entryId, version: saved, status: entry.status as KnowledgeStatus },
      entityType: "knowledge_entry", entityId: input.entryId, topic: "knowledge.rejected",
      after: { duplicateOf: input.duplicateOfEntryId ?? null },
    };
  });
}

/**
 * Merge a duplicate into the entry that already answers it.
 *
 * The duplicate's question and every alias it carried become aliases of the target, so the
 * phrasings people actually used keep resolving — losing them would make the same question
 * get re-captured tomorrow.
 */
export function mergeKnowledge(pool: PoolLike, input: CommandInputMap["knowledge.merge"], context: CommandContext): Promise<StoredOutcome<KnowledgeResult>> {
  return runPostgresCommand(pool, "knowledge.merge", input, context, async (db) => {
    const entry = await lockEntry(db, context, input.entryId, input.expectedVersion);
    const target = await db.query<{ entry_id: string }>(
      `SELECT entry_id FROM nzi_console.knowledge_entries WHERE organisation_id=$1 AND entry_id=$2 AND active`,
      [context.organisationId, input.intoEntryId]);
    if (!target.rows[0]) throw new CommandValidationError([{ field: "intoEntryId", code: "NOT_FOUND", message: "The entry to merge into does not exist." }]);

    await db.query(
      `INSERT INTO nzi_console.knowledge_entry_aliases (organisation_id, entry_id, alias_key, alias_question, added_by)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [context.organisationId, input.intoEntryId, entry.canonical_key, entry.canonical_question, context.actorId]);
    await db.query(
      `INSERT INTO nzi_console.knowledge_entry_aliases (organisation_id, entry_id, alias_key, alias_question, added_by)
       SELECT $1, $2, a.alias_key, a.alias_question, $4 FROM nzi_console.knowledge_entry_aliases a
       WHERE a.organisation_id=$1 AND a.entry_id=$3
       ON CONFLICT DO NOTHING`,
      [context.organisationId, input.intoEntryId, input.entryId, context.actorId]);

    const saved = await closeEntry(db, context, input.entryId, input.expectedVersion, input.intoEntryId);
    await recordKnowledgeVersion(db, { organisationId: context.organisationId, entryId: input.entryId, version: saved, change: "merged", changedBy: context.actorId, correlationId: context.correlationId });
    return {
      data: { entryId: input.entryId, version: saved, status: entry.status as KnowledgeStatus },
      entityType: "knowledge_entry", entityId: input.entryId, topic: "knowledge.merged",
      after: { mergedInto: input.intoEntryId },
    };
  });
}

/* ── shared ──────────────────────────────────────────────────────────────────────────── */

/** The status rule, refused in the words the person needs. */
function refuseTransition(status: string, transition: "approve" | "publish"): void {
  const refusal = transitionRefusal(status as KnowledgeStatus, transition);
  if (refusal !== null) throw new CommandValidationError([{ field: "entryId", code: "INVALID", message: refusal }]);
}

async function updateEntry(db: Queryable, context: CommandContext, entryId: string, expectedVersion: number, set: string, params: unknown[]): Promise<number> {
  const saved = await db.query<{ version: number }>(
    `UPDATE nzi_console.knowledge_entries SET ${set}, version=version+1, updated_by=$${params.length + 4}, updated_at=now()
     WHERE organisation_id=$1 AND entry_id=$2 AND version=$3 RETURNING version`,
    [context.organisationId, entryId, expectedVersion, ...params, context.actorId]);
  if (!saved.rows[0]) throw new VersionConflictError();
  return saved.rows[0].version;
}

/** Withdraw an entry. Deactivated, never deleted: what was cited stays explicable. */
async function closeEntry(db: Queryable, context: CommandContext, entryId: string, expectedVersion: number, duplicateOf: string | null): Promise<number> {
  const saved = await db.query<{ version: number }>(
    `UPDATE nzi_console.knowledge_entries
     SET active=false, duplicate_of_entry_id=$4, deactivated_by=$5, deactivated_at=now(),
         version=version+1, updated_by=$5, updated_at=now()
     WHERE organisation_id=$1 AND entry_id=$2 AND version=$3 RETURNING version`,
    [context.organisationId, entryId, expectedVersion, duplicateOf, context.actorId]);
  if (!saved.rows[0]) throw new VersionConflictError();
  return saved.rows[0].version;
}
