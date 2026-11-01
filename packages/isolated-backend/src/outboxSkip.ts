import { randomUUID } from "node:crypto";
import type { PoolLike, Queryable } from "./postgres";
import { withTenantRead, withTenantWrite } from "./postgres";

/**
 * Skip-only clearing of the unconsumed outbox backlog (BRIEF-outbox-skip-cleanup).
 *
 * `transactional_outbox` has been written by every command since 0001. Exactly two topics have a real consumer — `email.send`
 * (the Resend drain) and `strategy.deadline.reminder` (the reminder drain). Everything else is a domain event that nothing reads,
 * so for a real organisation it only ever accumulates, as `pending`.
 *
 * This module marks those rows `skipped` and does nothing else: it imports no mailer, no email sender and no reminder scan, it
 * never reads a payload, and it can deliver nothing, because the only thing it writes is `state`. The payload, topic, attempts and
 * timestamps are left exactly as they were, so a skipped row is still an intact record — a later consumer can select
 * `state = 'skipped'` by topic and replay deliberately. What `skipped` ends is the drain's interest in the row, not its existence.
 *
 * The two real topics are named here as literals rather than imported, so this file stays free of the delivery code; a test pins
 * them to the exports in email.ts and strategyReminderWorker.ts so they cannot drift.
 */

export const OUTBOX_EMAIL_TOPIC = "email.send";
export const OUTBOX_REMINDER_TOPIC = "strategy.deadline.reminder";
/** The topics that always stay with their real handlers. A caller may add to the kept set; it can never shrink this one. */
export const OUTBOX_CONSUMED_TOPICS: readonly string[] = [OUTBOX_EMAIL_TOPIC, OUTBOX_REMINDER_TOPIC];

export const OUTBOX_SKIP_BATCH = 500;
export const OUTBOX_SKIP_AUDIT_ACTION = "outbox.backlog.skipped";

export type OutboxSkipCounts = { byTopic: Record<string, number>; total: number };

const keptTopics = (extraKept: readonly string[] = []) => [...new Set([...OUTBOX_CONSUMED_TOPICS, ...extraKept])];

/** What a skip would mark, per topic. Read-only. */
export async function countUnconsumedOutbox(db: Queryable, organisationId: string, extraKept: readonly string[] = []): Promise<OutboxSkipCounts> {
  const { rows } = await db.query<{ topic: string; n: string }>(
    `SELECT topic, count(*)::text AS n FROM nzi_console.transactional_outbox
     WHERE organisation_id = $1 AND state = 'pending' AND topic <> ALL($2::text[])
     GROUP BY topic ORDER BY topic`,
    [organisationId, keptTopics(extraKept)]);
  const byTopic: Record<string, number> = {};
  let total = 0;
  for (const row of rows) { byTopic[row.topic] = Number(row.n); total += Number(row.n); }
  return { byTopic, total };
}

/**
 * Skip at most `limit` pending rows of unconsumed topics, in the caller's transaction. Returns the per-topic counts it marked.
 * Only `pending` rows move — a `processing`, `failed` or already `skipped` row is never touched, so a re-run is a no-op.
 */
export async function skipUnconsumedOutbox(db: Queryable, organisationId: string, limit = OUTBOX_SKIP_BATCH,
  extraKept: readonly string[] = []): Promise<OutboxSkipCounts> {
  const { rows } = await db.query<{ topic: string; n: string }>(
    `WITH batch AS (
       SELECT outbox_id FROM nzi_console.transactional_outbox
       WHERE organisation_id = $1 AND state = 'pending' AND topic <> ALL($2::text[])
       ORDER BY created_at, outbox_id
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     ), marked AS (
       UPDATE nzi_console.transactional_outbox o SET state = 'skipped'
       FROM batch WHERE o.organisation_id = $1 AND o.outbox_id = batch.outbox_id AND o.state = 'pending'
       RETURNING o.topic
     )
     SELECT topic, count(*)::text AS n FROM marked GROUP BY topic ORDER BY topic`,
    [organisationId, keptTopics(extraKept), limit]);
  const byTopic: Record<string, number> = {};
  let total = 0;
  for (const row of rows) { byTopic[row.topic] = Number(row.n); total += Number(row.n); }
  return { byTopic, total };
}

export type OutboxSkipRun = OutboxSkipCounts & { batches: number; committed: boolean; kept: string[] };

/**
 * The owner-run clean-up. Dry run (the default) counts per topic and writes nothing. `commit` skips in batches — each batch its
 * own transaction, so a long backlog never holds one lock — then writes ONE counts-only audit event. Idempotent: with nothing
 * pending the run marks nothing and writes no audit event.
 */
export async function clearUnconsumedOutbox(pool: PoolLike, organisationId: string,
  options: { commit: boolean; actorId?: string; batchSize?: number; extraKept?: readonly string[]; onBatch?: (batch: OutboxSkipCounts) => void }): Promise<OutboxSkipRun> {
  const extraKept = options.extraKept ?? [];
  const kept = keptTopics(extraKept);
  if (!options.commit) {
    const counts = await withTenantRead(pool, organisationId, (db) => countUnconsumedOutbox(db, organisationId, extraKept));
    return { ...counts, batches: 0, committed: false, kept };
  }
  if (!options.actorId?.trim()) throw new Error("A commit needs an actor: the audit event records who cleared the backlog.");
  const batchSize = options.batchSize ?? OUTBOX_SKIP_BATCH;
  const byTopic: Record<string, number> = {};
  let total = 0, batches = 0;
  for (;;) {
    const batch = await withTenantWrite(pool, organisationId, (db) => skipUnconsumedOutbox(db, organisationId, batchSize, extraKept));
    if (batch.total === 0) break;
    batches += 1;
    total += batch.total;
    for (const [topic, n] of Object.entries(batch.byTopic)) byTopic[topic] = (byTopic[topic] ?? 0) + n;
    options.onBatch?.(batch);
  }
  if (total > 0) {
    await withTenantWrite(pool, organisationId, (db) => db.query(
      `INSERT INTO nzi_console.audit_events (organisation_id,audit_event_id,actor_id,principal_type,action,entity_type,entity_id,correlation_id,reason,after_json)
       VALUES ($1,$2,$3,'system',$4,'organisation',$1,$5,$6,$7::jsonb)`,
      [organisationId, `audit-${randomUUID()}`, options.actorId, OUTBOX_SKIP_AUDIT_ACTION, randomUUID(),
        "Unconsumed outbox backlog marked skipped: no delivery, no payload read",
        JSON.stringify({ skipped: total, byTopic, batches, kept })]));
  }
  return { byTopic, total, batches, committed: true, kept };
}
