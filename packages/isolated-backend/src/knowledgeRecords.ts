import {
  KNOWLEDGE_SIMILARITY_FLOOR, knowledgeKey,
  type KnowledgeEntry, type KnowledgeSimilarCandidate, type KnowledgeStatus,
} from "@nzi/contracts";
import type { Queryable } from "./postgres";

/**
 * Reading the knowledge library.
 *
 * NZI-wide by construction: every query here is scoped by the tenant policy to the
 * consultancy organisation and by nothing else. There is no client filter because there is
 * no client column — the library is shared, and an answer written on one client's work is
 * meant to be found by everyone.
 */

type EntryRow = {
  entry_id: string; canonical_question: string; canonical_key: string; answer: string;
  status: string; category: string; area: string;
  asked_by: string; drafted_by: string; drafted_by_kind: string;
  approved_by: string | null; approved_at: Date | string | null;
  published_by: string | null; published_at: Date | string | null;
  possible_duplicate: boolean; duplicate_of_entry_id: string | null; revises_entry_id: string | null;
  version: number; active: boolean; created_by: string;
  created_at: Date | string; updated_at: Date | string;
  aliases: Array<{ key: string; question: string }> | null;
};

const iso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : String(value);

const mapEntry = (row: EntryRow): KnowledgeEntry => ({
  id: row.entry_id,
  canonicalQuestion: row.canonical_question,
  canonicalKey: row.canonical_key,
  answer: row.answer,
  status: row.status as KnowledgeStatus,
  category: row.category,
  area: row.area,
  aliases: row.aliases ?? [],
  askedBy: row.asked_by,
  draftedBy: row.drafted_by,
  draftedByKind: row.drafted_by_kind === "ai" ? "ai" : "human",
  approvedBy: row.approved_by,
  approvedAt: iso(row.approved_at),
  publishedBy: row.published_by,
  publishedAt: iso(row.published_at),
  possibleDuplicate: row.possible_duplicate,
  duplicateOfEntryId: row.duplicate_of_entry_id,
  revisesEntryId: row.revises_entry_id,
  version: row.version,
  active: row.active,
  createdBy: row.created_by,
  createdAt: iso(row.created_at)!,
  updatedAt: iso(row.updated_at)!,
});

const ENTRY_COLUMNS = `e.entry_id, e.canonical_question, e.canonical_key, e.answer, e.status, e.category, e.area,
  e.asked_by, e.drafted_by, e.drafted_by_kind, e.approved_by, e.approved_at, e.published_by, e.published_at,
  e.possible_duplicate, e.duplicate_of_entry_id, e.revises_entry_id, e.version, e.active,
  e.created_by, e.created_at, e.updated_at,
  coalesce((SELECT jsonb_agg(jsonb_build_object('key', a.alias_key, 'question', a.alias_question) ORDER BY a.alias_key)
            FROM nzi_console.knowledge_entry_aliases a
            WHERE (a.organisation_id, a.entry_id) = (e.organisation_id, e.entry_id)), '[]'::jsonb) AS aliases`;

/** The approved library — what the Library view browses and what grounds the help AI. */
export async function listKnowledgeEntries(db: Queryable, filter?: { status?: KnowledgeStatus }): Promise<KnowledgeEntry[]> {
  const result = await db.query<EntryRow>(
    `SELECT ${ENTRY_COLUMNS} FROM nzi_console.knowledge_entries e
     WHERE e.active AND ($1::text IS NULL OR e.status = $1)
     ORDER BY e.status DESC, lower(e.canonical_question)`,
    [filter?.status ?? null]);
  return result.rows.map(mapEntry);
}

/** The review queue: drafts awaiting a decision, oldest first — nothing waits indefinitely. */
export async function listKnowledgeQueue(db: Queryable): Promise<KnowledgeEntry[]> {
  const result = await db.query<EntryRow>(
    `SELECT ${ENTRY_COLUMNS} FROM nzi_console.knowledge_entries e
     WHERE e.active AND e.status = 'draft'
     ORDER BY e.possible_duplicate DESC, e.created_at`,
    []);
  return result.rows.map(mapEntry);
}

export async function getKnowledgeEntry(db: Queryable, entryId: string): Promise<KnowledgeEntry | null> {
  const result = await db.query<EntryRow>(
    `SELECT ${ENTRY_COLUMNS} FROM nzi_console.knowledge_entries e WHERE e.entry_id = $1`, [entryId]);
  return result.rows[0] ? mapEntry(result.rows[0]) : null;
}

/**
 * Questions close enough to be worth showing someone before they create a rival entry.
 *
 * Searches **approved entries and pending drafts together**: "someone already asked this and
 * it is waiting for review" is as useful as "this is already answered", and only one of them
 * is in the approved set.
 *
 * Trigram similarity is lexical — it catches shared-word rephrasings and misses semantic
 * ones ("is the report externally verified?" against "what does reviewed not assured mean?").
 * That is acceptable *because a person adjudicates*: this ranks candidates for a human, it
 * never merges anything. Embedding similarity is the eventual upgrade (NZC-081).
 */
export async function findSimilarKnowledge(
  db: Queryable,
  question: string,
  options?: { excludeEntryId?: string; limit?: number },
): Promise<KnowledgeSimilarCandidate[]> {
  const key = knowledgeKey(question);
  if (key === "") return [];
  const result = await db.query<{
    entry_id: string; question: string; status: string; matched_on: string; score: number; drafted_by: string | null;
  }>(
    `WITH scored AS (
       SELECT e.entry_id, e.canonical_question AS question, e.status,
              'canonical' AS matched_on, similarity(e.canonical_key, $1) AS score,
              CASE WHEN e.status = 'draft' THEN e.drafted_by ELSE NULL END AS drafted_by
       FROM nzi_console.knowledge_entries e
       WHERE e.active AND ($2::text IS NULL OR e.entry_id <> $2)
       UNION ALL
       SELECT e.entry_id, e.canonical_question, e.status,
              'alias', similarity(a.alias_key, $1),
              CASE WHEN e.status = 'draft' THEN e.drafted_by ELSE NULL END
       FROM nzi_console.knowledge_entry_aliases a
       JOIN nzi_console.knowledge_entries e ON (e.organisation_id, e.entry_id) = (a.organisation_id, a.entry_id)
       WHERE e.active AND ($2::text IS NULL OR e.entry_id <> $2)
     )
     SELECT DISTINCT ON (entry_id) entry_id, question, status, matched_on, score, drafted_by
     FROM scored WHERE score >= $3
     ORDER BY entry_id, score DESC`,
    [key, options?.excludeEntryId ?? null, KNOWLEDGE_SIMILARITY_FLOOR]);

  return result.rows
    .map((row) => ({
      entryId: row.entry_id,
      question: row.question,
      status: row.status as KnowledgeStatus,
      matchedOn: row.matched_on === "alias" ? "alias" as const : "canonical" as const,
      score: Number(row.score),
      draftedBy: row.drafted_by,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, options?.limit ?? 8);
}

/** Append-only history for one entry, newest first. */
export async function listKnowledgeVersions(db: Queryable, entryId: string): Promise<Array<{
  version: number; change: string; changedBy: string; changedAt: string;
}>> {
  const result = await db.query<{ version: number; change: string; changed_by: string; changed_at: Date | string }>(
    `SELECT version, change, changed_by, changed_at FROM nzi_console.knowledge_entry_versions
     WHERE entry_id = $1 ORDER BY version DESC`, [entryId]);
  return result.rows.map((row) => ({
    version: row.version, change: row.change, changedBy: row.changed_by, changedAt: iso(row.changed_at)!,
  }));
}

/** Snapshot the entry as it now stands. Called by every command that changes one. */
export async function recordKnowledgeVersion(
  db: Queryable,
  input: { organisationId: string; entryId: string; version: number; change: string; changedBy: string; correlationId?: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO nzi_console.knowledge_entry_versions
       (organisation_id, entry_id, version, snapshot_json, changed_by, change, correlation_id)
     SELECT $1, $2, $3, to_jsonb(e) - 'organisation_id', $4, $5, $6
     FROM nzi_console.knowledge_entries e
     WHERE e.organisation_id = $1 AND e.entry_id = $2`,
    [input.organisationId, input.entryId, input.version, input.changedBy, input.change, input.correlationId ?? null]);
}
