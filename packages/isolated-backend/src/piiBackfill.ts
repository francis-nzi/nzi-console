import type { PoolClient } from "pg";
import {
  SEALABLE_ROWS, plaintextColumnsOf, sealExistingRow, unsealedPredicate,
  type SealableRow, type SealingKeys,
} from "./piiSealing";
import type { PoolLike } from "./postgres";

/**
 * Encrypting the personal data that is already there (NZC-119).
 *
 * ## Resumable without a progress table
 *
 * The queue is the work itself: a row is outstanding exactly when it has plaintext and no ciphertext,
 * which is {@link unsealedPredicate}. So an interrupted run has simply left more to do, a second run
 * continues from wherever the first stopped, and a finished run selects nothing. Nothing has to be
 * recorded about where it got to, which means nothing can be wrong about where it got to — and a
 * progress row that disagrees with the data is its own species of outage.
 *
 * Each batch is its own transaction, so a crash costs at most one batch and never half a row: a row's
 * plaintext, its ciphertext, its index and its linkage digest commit together or not at all.
 *
 * ## Why it must run behind dual-write, not before
 *
 * A row created while this is running would otherwise land with plaintext and no ciphertext, and the
 * backfill would already have passed the place where it appeared. Unencrypted, therefore unerasable,
 * and nothing anywhere saying so. Dual-write goes first; this closes the history.
 *
 * ## It seals with the same code the application does
 *
 * Every value here goes through `sealExistingRow` onto `sealRowPii` — the one sealing path. A second
 * implementation for the operator's side would agree on the day it was written and drift afterwards,
 * and the symptom of that drift is a row that looks encrypted and cannot be read back.
 */

export type BackfillOptions = {
  organisationId: string;
  actorId: string;
  keys: SealingKeys;
  /** Rows per transaction. Small enough to hold no lock for long, large enough to be worth a round trip. */
  batchSize?: number;
  /** Count what is outstanding and write nothing. */
  dryRun?: boolean;
  onProgress?: (progress: { table: string; sealed: number; outstanding: number }) => void;
};

export type BackfillOutcome = {
  organisationId: string;
  dryRun: boolean;
  tables: Array<{ table: string; outstandingBefore: number; sealed: number; outstandingAfter: number }>;
};

const countOutstanding = async (client: PoolClient, descriptor: SealableRow, organisationId: string): Promise<number> => {
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM nzi_console.${descriptor.table}
      WHERE organisation_id=$1 AND (${unsealedPredicate(descriptor)})`,
    [organisationId]);
  return Number(rows[0]?.count ?? "0");
};

/**
 * A single batch, in its own transaction.
 *
 * `FOR UPDATE SKIP LOCKED` so two operators running this at once divide the work instead of waiting on
 * each other — and so a row another transaction is mid-write on is left for the next pass rather than
 * blocking the backfill behind it.
 */
async function sealBatch(
  client: PoolClient, descriptor: SealableRow, options: BackfillOptions, batchSize: number,
): Promise<{ selected: number; sealed: number }> {
  const columns = [descriptor.keyColumn, descriptor.subjectIdColumn, ...plaintextColumnsOf(descriptor)];
  const selected = [...new Set(columns)].join(",");

  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.organisation_id', $1, true)", [options.organisationId]);
    const { rows } = await client.query<Record<string, string | null>>(
      `SELECT ${selected} FROM nzi_console.${descriptor.table}
        WHERE organisation_id=$1 AND (${unsealedPredicate(descriptor)})
        ORDER BY ${descriptor.keyColumn}
        LIMIT ${batchSize} FOR UPDATE SKIP LOCKED`,
      [options.organisationId]);

    let sealed = 0;
    for (const row of rows) {
      // A row whose subject cannot be named is left alone rather than sealed under a stand-in: a key
      // attached to the wrong person is worse than plaintext, because erasure would then miss it.
      if (!row[descriptor.subjectIdColumn]) continue;
      await sealExistingRow(client, options.organisationId, descriptor, row, options.keys, options.actorId);
      sealed += 1;
    }
    await client.query("COMMIT");
    return { selected: rows.length, sealed };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function backfillSealedPii(pool: PoolLike, options: BackfillOptions): Promise<BackfillOutcome> {
  const batchSize = options.batchSize ?? 200;
  const tables: BackfillOutcome["tables"] = [];
  const client = (await pool.connect()) as PoolClient;
  try {
    for (const descriptor of SEALABLE_ROWS) {
      await client.query("BEGIN READ ONLY");
      await client.query("SELECT set_config('app.organisation_id', $1, true)", [options.organisationId]);
      const outstandingBefore = await countOutstanding(client, descriptor, options.organisationId);
      await client.query("COMMIT");

      let sealed = 0;
      if (!options.dryRun) {
        // Stops when a pass seals nothing, which covers both "finished" and "everything left is a row
        // with no subject to key it to". Sealing nothing — rather than selecting nothing — is the
        // termination condition, because a batch of rows the loop cannot seal would otherwise be
        // selected again for ever.
        for (;;) {
          const batch = await sealBatch(client, descriptor, options, batchSize);
          if (batch.sealed === 0) break;
          sealed += batch.sealed;
          options.onProgress?.({ table: descriptor.table, sealed, outstanding: Math.max(outstandingBefore - sealed, 0) });

          // A row that is sealed stops matching the queue, so the total sealed cannot exceed what was
          // outstanding — one batch of slack for rows a live writer adds while this runs. Past that, the
          // loop is re-selecting rows its own writes did not clear, and it would spin here for ever
          // issuing fast queries: no statement blocks, no timeout fires, and it looks like a slow pass
          // rather than a stuck one. Say which table, and stop.
          if (sealed > outstandingBefore + batchSize) {
            throw new Error(
              `${descriptor.table}: sealed ${sealed} rows with only ${outstandingBefore} outstanding, so ` +
              `sealing is not clearing the queue and this would not terminate. The predicate and the write ` +
              `disagree about what counts as sealed.`);
          }
        }
      }

      await client.query("BEGIN READ ONLY");
      await client.query("SELECT set_config('app.organisation_id', $1, true)", [options.organisationId]);
      const outstandingAfter = await countOutstanding(client, descriptor, options.organisationId);
      await client.query("COMMIT");

      tables.push({ table: descriptor.table, outstandingBefore, sealed, outstandingAfter });
    }
  } finally {
    client.release();
  }
  return { organisationId: options.organisationId, dryRun: options.dryRun ?? false, tables };
}
