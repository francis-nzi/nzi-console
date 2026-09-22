import { randomUUID } from "node:crypto";
import {
  blindIndex, createSubjectKey, linkageDigest, normaliseEmailAtRest, sealForSubject, unwrapSubjectKey,
  type IndexedColumn, type SealedValue, type WrappedKey,
} from "./subjectCrypto";
import type { Queryable } from "./postgres";
import {
  indexColumnOf, PII_COLUMNS, PII_TABLES, sealedColumnOf, type PiiErasure, type SubjectTable,
} from "./piiInventory";

/**
 * The one path by which personal data becomes ciphertext (NZC-119).
 *
 * Every writer goes through here — the command layer, the operator provisioning script, and the
 * backfill. There is deliberately no second sealing implementation, because two of them would agree
 * on the day they were written and drift silently afterwards, and the symptom of drift here is a row
 * that looks encrypted and cannot be decrypted.
 *
 * ## Why a write has to resolve a subject first
 *
 * A field is encrypted under *that person's* key, so sealing requires knowing whose row this is. The
 * registry (NZC-116) answers that for rows it has seen; a row being created right now has not been
 * seen. So the write path resolves a subject inline, by the same rule the linker uses, and mints one
 * when there is no match.
 *
 * That makes the write path the primary assigner of subjects and leaves the linker as the reconciler
 * it already was: additive, idempotent, skipping anything already linked. A shared mailbox still
 * fuses nobody, because an address that also appears inside the same source table is not joined here
 * either — it gets its own subject, and the linker raises the question for a human.
 *
 * ## The window this closes
 *
 * Without dual-writing, a row created while the backfill runs lands with plaintext and no ciphertext
 * — unencrypted, therefore unerasable, with nothing to report it. So dual-write goes in *before* the
 * backfill, and {@link SEALED_COLUMNS} is what the standing check afterwards proves over.
 */

/** The keys a sealing write needs. Always passed in; nothing here reads the environment. */
export type SealingKeys = { masterKey: string; indexKey: string; linkageKey: string };

/** The person whose key seals this row, as the registry names them. */
export type SubjectRef = {
  /** One of the four person-tables the registry links. */
  sourceTable: "trainees" | "client_contacts" | "portal_users" | "memberships";
  sourceId: string;
};

/**
 * One address that is used and not merely shown: sealed, indexed for equality, and given a linkage
 * digest — three derivations of a single value, computed together so they cannot disagree about it.
 */
export type OperationalField = {
  column: IndexedColumn;
  sealedColumn: string;
  indexColumn: string;
  /** Which address on the row, for a row with more than one. Matches `data_subject_linkage.field`. */
  field: string;
  value: string | null | undefined;
};

export type SealRequest = {
  organisationId: string;
  /**
   * Whose key seals this. Not always the row being written: a trainee's email-change record seals
   * under the trainee, because the registry links only the four person-tables and a change record is
   * not one of them.
   */
  subject: SubjectRef;
  /** The row being written. */
  table: string;
  keyColumns: Record<string, string>;
  /** Where to record linkage digests — the row's own table, which may differ from the subject's. */
  linkageTable?: string;
  linkageId?: string;
  /** Display-only fields: `{ sealedColumn: plaintext }`. */
  sealed?: Record<string, string | null | undefined>;
  operational?: readonly OperationalField[];
};

const asJson = (value: SealedValue | null) => (value === null ? null : JSON.stringify(value));

/**
 * A field holding nothing, including a field holding only spaces.
 *
 * It has to agree exactly with what {@link unsealedPredicate} counts as absent. If sealing treated a
 * single space as a value and the queue treated it as nothing, the row would be sealed and then
 * selected again for ever; if they disagreed the other way, a real value would be skipped.
 */
const isBlank = (value: unknown): boolean => value == null || String(value).trim() === "";

/**
 * A stored value as the text to encrypt.
 *
 * A `jsonb` column arrives from `pg` already parsed into an object, and `String(…)` on one of those
 * yields "[object Object]" — which would seal successfully, decrypt successfully, and have thrown the
 * snapshot away. So anything that is not already a string is re-serialised rather than coerced.
 */
const asText = (value: unknown): string | null =>
  value == null ? null : typeof value === "string" ? value : JSON.stringify(value);

/**
 * The subject this row belongs to, minting one if the row is new.
 *
 * Joins an existing subject only when the address already appears **in a different source table,
 * under exactly one subject**. Two rows sharing an address inside one table is a shared mailbox
 * rather than a person, and fusing them would make one erasure take both; two rival subjects across
 * tables is an open question, not an answer. Either way the row gets its own subject and the linker
 * queues it for review.
 */
async function resolveSubject(
  db: Queryable, organisationId: string, subject: SubjectRef,
  addresses: readonly (string | null)[], keys: SealingKeys, actorId: string,
): Promise<string> {
  const existing = await db.query<{ subject_id: string }>(
    `SELECT subject_id FROM nzi_console.data_subject_links
      WHERE organisation_id=$1 AND source_table=$2 AND source_id=$3`,
    [organisationId, subject.sourceTable, subject.sourceId]);
  if (existing.rows[0]) return existing.rows[0].subject_id;

  const digests = addresses
    .map((value) => linkageDigest(value, keys.linkageKey))
    .filter((digest): digest is string => digest !== null);
  let subjectId: string | null = null;

  if (digests.length > 0) {
    // Through the privileged door, never the table (NZC-121). An earlier version of this joined
    // `data_subject_linkage` directly, which is the correlating read NZC-118 confined — done by the very
    // role it was confined against. The grant refused it, which is the argument for a confinement being
    // a privilege rather than a convention.
    const peers = await db.query<{ subject_id: string; same_table: boolean }>(
      `SELECT subject_id, same_table FROM nzi_console.subjects_sharing_linkage($1,$2,$3::text[])`,
      [organisationId, subject.sourceTable, digests]);
    const candidates = new Set(peers.rows.map((row) => row.subject_id));
    if (candidates.size === 1 && peers.rows.every((row) => !row.same_table)) {
      subjectId = [...candidates][0]!;
    }
  }

  if (subjectId === null) {
    subjectId = randomUUID();
    await db.query(
      `INSERT INTO nzi_console.data_subjects (organisation_id,subject_id,created_by) VALUES ($1,$2,$3)`,
      [organisationId, subjectId, actorId]);
  }

  await db.query(
    `INSERT INTO nzi_console.data_subject_links (organisation_id,subject_id,source_table,source_id,link_method,linked_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (organisation_id,source_table,source_id) DO NOTHING`,
    [organisationId, subjectId, subject.sourceTable, subject.sourceId,
      digests.length === 0 ? "unlinked-no-key" : "deterministic-email", actorId]);

  return subjectId;
}

/**
 * The subject's data key, minting and storing one the first time it is needed.
 *
 * Throws `SubjectKeyShreddedError` for an erased subject, which is the right answer: writing new
 * personal data for somebody who has been erased would re-create what erasure destroyed.
 */
async function subjectKey(db: Queryable, organisationId: string, subjectId: string, keys: SealingKeys): Promise<Buffer> {
  const stored = await db.query<{ wrapped_key: WrappedKey | null }>(
    `SELECT wrapped_key FROM nzi_console.data_subject_keys WHERE organisation_id=$1 AND subject_id=$2`,
    [organisationId, subjectId]);
  if (stored.rows[0]) return unwrapSubjectKey(stored.rows[0].wrapped_key, keys.masterKey);

  const { key, wrapped } = createSubjectKey(keys.masterKey);
  const claimed = await db.query<{ wrapped_key: WrappedKey | null }>(
    `INSERT INTO nzi_console.data_subject_keys (organisation_id,subject_id,wrapped_key)
     VALUES ($1,$2,$3::jsonb) ON CONFLICT (organisation_id,subject_id) DO NOTHING
     RETURNING wrapped_key`,
    [organisationId, subjectId, JSON.stringify(wrapped)]);
  if (claimed.rows[0]) return key;

  // No row came back, so a concurrent writer won the conflict and its key is the one to use. Two
  // writers sealing one person's fields under two different keys would leave half of them
  // permanently unreadable, so this reads theirs rather than keeping the key just generated.
  const settled = await db.query<{ wrapped_key: WrappedKey | null }>(
    `SELECT wrapped_key FROM nzi_console.data_subject_keys WHERE organisation_id=$1 AND subject_id=$2`,
    [organisationId, subjectId]);
  if (settled.rows.length === 0) {
    // Neither inserted nor found. Not a shredded key — a shred leaves the row — so say what it is
    // rather than reporting an erasure that did not happen.
    throw new Error(`No key row for subject ${subjectId}: the insert was rejected and nothing is stored.`);
  }
  return unwrapSubjectKey(settled.rows[0]!.wrapped_key, keys.masterKey);
}

/**
 * Seal one row's personal data, in the caller's transaction.
 *
 * Called immediately after the plaintext write and inside the same transaction, so a row is never
 * committed with one and not the other. Table and key columns are passed explicitly rather than
 * inferred, because a wrong guess here writes one person's ciphertext onto another's row.
 */
/**
 * The ciphertext for a row that has not been written yet.
 *
 * Sealing normally follows the plaintext write, as an UPDATE in the same transaction. An append-only
 * table cannot be updated at all: 0067 revokes UPDATE on `client_contact_versions` from every runtime
 * role, because history that can be rewritten is not history. So for those tables the ciphertext has to
 * travel in the INSERT that creates the row, and this returns it instead of writing it.
 *
 * Same subject, same key, same crypto as `sealRowPii` — only the statement differs. It resolves (and
 * where necessary mints) the subject, which is a write, so it belongs inside the caller's transaction
 * like every other part of the seal.
 */
export async function sealValuesForSubject(
  db: Queryable,
  request: { organisationId: string; subject: SubjectRef; values: Readonly<Record<string, unknown>> },
  keys: SealingKeys,
  actorId: string,
): Promise<Record<string, string | null>> {
  const offered = Object.entries(request.values).filter(([, value]) => !isBlank(value));
  // No subject is minted for a call that seals nothing, for the same reason sealRowPii mints none.
  if (offered.length === 0) return {};

  const subjectId = await resolveSubject(db, request.organisationId, request.subject, [], keys, actorId);
  const key = await subjectKey(db, request.organisationId, subjectId, keys);
  return Object.fromEntries(offered.map(([column, value]) =>
    [column, asJson(sealForSubject(asText(value)!.trim(), key))]));
}

export async function sealRowPii(
  db: Queryable, request: SealRequest, keys: SealingKeys, actorId: string,
): Promise<{ subjectId: string | null }> {
  const { organisationId, subject, table, keyColumns } = request;
  const operational = request.operational ?? [];
  if (Object.keys(request.sealed ?? {}).length === 0 && operational.length === 0) {
    // Nothing was offered, so nothing is sealed — and no subject is minted. A call that seals no
    // field must not leave a person behind in the registry as a side effect of being made.
    return { subjectId: null };
  }
  const addresses = operational.map((field) => (isBlank(field.value) ? null : normaliseEmailAtRest(String(field.value))));

  const subjectId = await resolveSubject(db, organisationId, subject, addresses, keys, actorId);
  const key = await subjectKey(db, organisationId, subjectId, keys);

  const assignments: string[] = [];
  const params: unknown[] = [];
  const add = (column: string, value: unknown) => {
    params.push(value);
    assignments.push(`${column}=$${params.length}${column.endsWith("_sealed") ? "::jsonb" : ""}`);
  };

  for (const [column, plaintext] of Object.entries(request.sealed ?? {})) {
    add(column, isBlank(plaintext) ? null : asJson(sealForSubject(String(plaintext).trim(), key)));
  }
  operational.forEach((field, index) => {
    const address = addresses[index] ?? null;
    add(field.sealedColumn, address === null ? null : asJson(sealForSubject(address, key)));
    add(field.indexColumn, blindIndex(field.column, field.value, keys.indexKey));
  });

  if (assignments.length > 0) {
    const where = Object.entries(keyColumns)
      .map(([column, value]) => { params.push(value); return `${column}=$${params.length}`; })
      .join(" AND ");
    await db.query(`UPDATE nzi_console.${table} SET ${assignments.join(",")} WHERE ${where}`, params);
  }

  // The linkage digest lives in its own table, which no role may touch directly at all: one function
  // writes the row in hand and returns nothing, so a digest cannot come back out (NZC-121).
  const linkageTable = request.linkageTable ?? subject.sourceTable;
  const linkageId = request.linkageId ?? subject.sourceId;
  for (const field of operational) {
    await db.query(
      `SELECT nzi_console.record_subject_linkage($1,$2,$3,$4,$5)`,
      [organisationId, linkageTable, linkageId, field.field, linkageDigest(field.value, keys.linkageKey)]);
  }

  return { subjectId };
}

/* ── Sealing a row that already exists ───────────────────────────────────────────────── */

/**
 * How the backfill reaches each row: where its subject is, and which plaintext column feeds which
 * ciphertext. The same descriptors the standing check reads, so the thing that fills the columns and
 * the thing that proves them filled cannot disagree about what the columns are.
 */
/**
 * How the backfill reaches each row — a view over {@link PII_COLUMNS}, not a second list (NZC-125).
 *
 * It used to be written out beside the column inventory, and the coverage test asserted the two agreed
 * in one direction: every column a descriptor filled appeared in the inventory. The direction it did
 * not assert is where the gap was — sixteen tables held personal data and six had a descriptor, so ten
 * tables' worth was unreachable from a subject and nothing said so. Deriving it removes the question.
 */
export type SealableRow = {
  table: string;
  /**
   * The columns that identify the row. Plural because a history row is identified by the record and
   * the version — `(contact_id, version)`, not `contact_id` — and keying on the record alone would
   * write one version's ciphertext onto every version of it.
   */
  keyColumns: readonly string[];
  subjectTable: SubjectRef["sourceTable"];
  subjectIdColumn: string;
  sealed: Readonly<Record<string, string>>;
  operational: ReadonlyArray<{ plaintext: string; column: IndexedColumn; sealedColumn: string; indexColumn: string; field: string }>;
  linkageTable?: string;
};

export const SEALABLE_ROWS: ReadonlyArray<SealableRow> = Object.entries(PII_TABLES)
  // A row is sealable when it *is* a person, or is the history of one — a pointer is excluded, because
  // it names somebody whose identity lives elsewhere and is sealed there.
  //
  // History seals under the key of the record it is history of, which is what makes one shred cover a
  // person's present and their past together. So its subject is its parent's subject, read from the
  // parent's own attribution rather than restated here.
  .filter(([, definition]) => definition.attribution.kind === "person-row" || definition.attribution.kind === "history-of")
  .map(([table, definition]) => {
    const own = definition.attribution;
    const source = own.kind === "history-of" ? PII_TABLES[own.table]!.attribution : own;
    const attribution = source as { kind: "person-row"; subjectTable: SubjectTable; subjectIdColumn: string };
    const columns = PII_COLUMNS.filter((column) => column.table === table);
    const sealed: Record<string, string> = {};
    for (const column of columns) {
      if (column.storage.kind === "sealed") sealed[column.column] = column.storage.sealed;
    }
    const operational = columns.flatMap((column) => column.storage.kind === "sealed-and-indexed"
      ? [{
          plaintext: column.column,
          column: column.storage.indexedAs,
          sealedColumn: column.storage.sealed,
          indexColumn: column.storage.index,
          field: column.storage.linkageField,
        }]
      : []);
    const linkageTable = definition.linkage && definition.linkage.table !== attribution.subjectTable
      ? definition.linkage.table
      : undefined;
    return {
      table,
      keyColumns: definition.keyColumns,
      subjectTable: attribution.subjectTable,
      subjectIdColumn: attribution.subjectIdColumn,
      sealed,
      operational,
      ...(linkageTable ? { linkageTable } : {}),
    };
  });

/** Every plaintext column one descriptor covers, sealed and operational alike. */
export const plaintextColumnsOf = (row: SealableRow): string[] =>
  [...Object.keys(row.sealed), ...row.operational.map((field) => field.plaintext)];

/**
 * The predicate the backfill treats as its queue: plaintext present, ciphertext absent.
 *
 * "Present" has to mean exactly what {@link isBlank} means, or the queue never empties. Several of
 * these columns are `NOT NULL DEFAULT ''` — `trainees.phone` and `trainees.current_employer_name`
 * among them — so a person who has given no phone number has an empty string, not a null. Sealing an
 * empty string writes null ciphertext, which `IS NOT NULL AND … IS NULL` would then select again on
 * the next pass, and the backfill would seal that row for ever without making progress.
 */
export const unsealedPredicate = (row: SealableRow): string =>
  plaintextColumnsOf(row)
    .map((plaintext) => {
      const sealed = row.sealed[plaintext] ?? row.operational.find((field) => field.plaintext === plaintext)!.sealedColumn;
      // Cast before trimming: `snapshot_json` is jsonb, which btrim cannot take, and a text column is
      // unchanged by it.
      return `(nullif(btrim(${plaintext}::text), '') IS NOT NULL AND ${sealed} IS NULL)`;
    })
    .join(" OR ");

/**
 * Seal one existing row, reading its plaintext from the row itself.
 *
 * The backfill needs no progress table: its queue is {@link unsealedPredicate}, so an interrupted run
 * simply has more left to do and re-running continues from wherever it stopped. The most a crash can
 * cost is the batch in flight, and re-sealing an already-sealed row is not attempted at all because
 * the predicate no longer selects it.
 */
export function sealExistingRow(
  db: Queryable, organisationId: string, descriptor: SealableRow,
  values: Record<string, unknown>, keys: SealingKeys, actorId: string,
): Promise<{ subjectId: string | null }> {
  const sealed: Record<string, string | null> = {};
  for (const [plaintext, column] of Object.entries(descriptor.sealed)) sealed[column] = asText(values[plaintext]);

  const keyColumns: Record<string, string> = { organisation_id: organisationId };
  for (const column of descriptor.keyColumns) keyColumns[column] = String(values[column]);

  return sealRowPii(db, {
    organisationId,
    subject: { sourceTable: descriptor.subjectTable, sourceId: String(values[descriptor.subjectIdColumn]) },
    table: descriptor.table,
    keyColumns,
    linkageTable: descriptor.linkageTable,
    linkageId: descriptor.linkageTable ? String(values[descriptor.keyColumns[0]!]) : undefined,
    sealed,
    operational: descriptor.operational.map((field) => ({
      column: field.column, sealedColumn: field.sealedColumn, indexColumn: field.indexColumn,
      field: field.field, value: asText(values[field.plaintext]),
    })),
  }, keys, actorId);
}

/**
 * Every column with a ciphertext column beside it — a view over {@link PII_COLUMNS} (NZC-125).
 *
 * The seal-coverage invariant reads this; the export and erasure read the inventory directly, because
 * they care about data this view drops: the linkage digests, which have no plaintext, and the personal
 * data inside JSON payloads, which has no ciphertext column to check.
 */
export const SEALED_COLUMNS: ReadonlyArray<{
  table: string; plaintext: string; sealed: string; index?: string;
  stage: "sealed" | "awaiting-auth-bridge" | "deferred";
  because?: string;
}> = PII_COLUMNS.flatMap((column) => {
  const sealedColumn = sealedColumnOf(column);
  if (!sealedColumn) return [];
  const index = indexColumnOf(column);
  return [{
    table: column.table,
    plaintext: column.column,
    sealed: sealedColumn,
    ...(index ? { index } : {}),
    stage: column.stage,
    ...(column.because ? { because: column.because } : {}),
  }];
});
/**
 * Personal data a key-shred does not reach — a view over the inventory (NZC-125).
 *
 * It was a prose list of things found while wiring. It is now whatever the inventory says has no
 * ciphertext column: data inside a JSON payload, and the linkage digests, which have no plaintext at
 * all. Each carries its own erasure treatment, because none of them can be crypto-shredded — a payload
 * is redacted or retained with a basis, and a digest is nulled.
 */
export const UNSEALED_PII_FOUND: ReadonlyArray<{
  table: string; column: string; erasure: PiiErasure; note: string;
}> = PII_COLUMNS.flatMap((column) => column.storage.kind === "json" || column.storage.kind === "digest"
  ? [{ table: column.table, column: column.column, erasure: column.erasure, note: column.because ?? column.label }]
  : []);
