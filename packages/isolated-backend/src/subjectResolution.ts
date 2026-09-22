import { randomUUID } from "node:crypto";
import { requireCapability, type StaffPrincipal } from "./auth";
import {
  attributionOf, indexColumnOf, isAttributable, PII_COLUMNS, PII_TABLES, sealedColumnOf,
  type PiiColumn, type PiiTable,
} from "./piiInventory";
import { resolveSealingKeys } from "./piiSealingKeys";
import { openForSubject, unwrapSubjectKey, SubjectKeyShreddedError, type SealedValue, type WrappedKey } from "./subjectCrypto";
import { withTenantWrite, type PoolLike } from "./postgres";
import type { SealingKeys } from "./piiSealing";

/**
 * Everything belonging to one person, gathered once (NZC-128).
 *
 * The shared read under both the subject access export and erasure. One path, so the two cannot come to
 * different conclusions about what a person's data *is* — an export that found a row erasure did not
 * would be a promise the erasure then broke, and neither would be visible from inside either.
 *
 * ## Two modes, one traversal
 *
 * Export needs the values, so it decrypts. Erasure needs only to know what exists, because it is about
 * to destroy the key that would read it — decrypting first would put the plaintext somewhere for no
 * reason. So {@link ResolveOptions.decrypt} switches the reading, never the reaching: both modes visit
 * exactly the same rows, which is what makes the two operations agree by construction.
 *
 * ## What it reaches, and what it says about the rest
 *
 * From the subject: the registry's links, the person-rows they name, those rows' history, and the
 * associations that point at them. Per row, the inventory names the columns — nothing here has its own
 * opinion about which columns hold personal data, which is the point of there being one enumeration.
 *
 * And the rest is *stated*, not dropped. Columns no subject path reaches come back in
 * {@link ResolvedSubject.notAttributable} with their reason, because an export that silently omitted
 * them would tell somebody they had been shown everything.
 *
 * ## The linkage digests are enumerated without being read
 *
 * `data_subject_linkage` is confined: no role holds a direct privilege on it (NZC-121). Nothing here
 * needs to read one — which rows have a digest, and under which field, follows from the inventory and
 * the links. So the digests are reported by *key* and never by value, and this path needs no privilege
 * on that table at all.
 */

export type ResolveOptions = {
  /** Read the sealed values. Export does; erasure does not, because it is about to destroy the key. */
  decrypt: boolean;
  keys?: SealingKeys;
};

export type ResolvedDatum = {
  table: string;
  column: string;
  /** What this is called when a person is shown it. */
  label: string;
  storage: PiiColumn["storage"]["kind"];
  /** The value, when it was read. Absent is not the same as empty. */
  value?: string | null;
  /** Why there is no value: not read, unreadable, or nothing stored. */
  unavailable?: string;
};

export type ResolvedRow = {
  table: string;
  keys: Readonly<Record<string, string>>;
  /** Why this row belongs to the subject — their record, its history, or something they are named on. */
  reach: "person-row" | "history-of" | "pointer";
  data: readonly ResolvedDatum[];
};

export type ResolvedSubject = {
  subjectId: string;
  organisationId: string;
  status: string;
  /** Null once the key is shredded, which is what erasure leaves behind. */
  keyPresent: boolean;
  rows: readonly ResolvedRow[];
  /** Which rows hold a matching digest, and under which field. Never the digest. */
  linkage: ReadonlyArray<{ sourceTable: string; sourceId: string; field: string }>;
  /** Personal data this system holds that no subject path reaches, with the reason for each. */
  notAttributable: ReadonlyArray<{ table: string; column: string; label: string; because: string }>;
  /**
   * The tables this traversal actually queried for this subject.
   *
   * Reported rather than re-derived, because a consumer that works out for itself which tables *should*
   * have been visited is comparing the inventory with the inventory and will agree with itself whatever
   * the traversal did. An export uses this to tell two very different situations apart: a table with no
   * rows for this person — where "we hold no record of this kind about you" is true — and a table the
   * traversal never reached at all, where saying that would be an affirmative false statement.
   */
  tablesConsidered: readonly string[];
  /**
   * Whether this person exists in another organisation is not answerable here, and saying so is the
   * honest answer rather than an omission.
   *
   * A `subject_id` is unique across the estate, so one subject is one organisation by construction. The
   * same person in two organisations is two subjects, and finding that out means comparing linkage
   * digests across tenants — which is exactly the privileged adjudication NZC-118 confined, and a
   * controllership question before it is a technical one.
   */
  crossTenant: "not-answerable-here";
};

const asText = (value: unknown): string | null =>
  value == null ? null : typeof value === "string" ? value : JSON.stringify(value);

/** The inventory's columns for a table, in inventory order. */
const columnsOf = (table: string): PiiColumn[] => PII_COLUMNS.filter((column) => column.table === table);

/**
 * Read one row's personal data, decrypting only if asked.
 *
 * Every branch produces a datum. A column that is absent, unreadable or deliberately not read is still
 * reported with the reason, because the shape of the answer is what an export renders and an erasure
 * counts — and a missing entry would be indistinguishable from a column nobody thought of.
 */
function readRow(
  columns: readonly PiiColumn[], row: Record<string, unknown>,
  subjectKey: Buffer | null, options: ResolveOptions,
): ResolvedDatum[] {
  return columns.map((column) => {
    const base = { table: column.table, column: column.column, label: column.label, storage: column.storage.kind };
    const sealedColumn = sealedColumnOf(column);

    if (sealedColumn) {
      const sealed = row[sealedColumn] as SealedValue | null | undefined;
      if (!sealed) {
        // No ciphertext. Either the value is genuinely absent, or the backfill has not reached it —
        // and the plaintext beside it says which, so it is read rather than guessed at.
        const plaintext = asText(row[column.column]);
        return plaintext === null
          ? { ...base, value: null, unavailable: "nothing stored" }
          : { ...base, value: plaintext, unavailable: "read from the plaintext column: this row is not yet sealed" };
      }
      if (!options.decrypt) return { ...base, unavailable: "held as ciphertext; not read" };
      if (!subjectKey) return { ...base, unavailable: "the key has been destroyed, so this can no longer be read" };
      try {
        return { ...base, value: openForSubject(sealed, subjectKey) };
      } catch {
        return { ...base, unavailable: "the ciphertext did not open under this subject's key" };
      }
    }

    // No ciphertext column at all: a JSON payload or a digest. A digest is never read.
    if (column.storage.kind === "digest") return { ...base, unavailable: "a matching digest, which is never read back" };
    const value = asText(row[column.column]);
    return value === null ? { ...base, value: null, unavailable: "nothing stored" } : { ...base, value };
  });
}

/** The columns a SELECT needs for a table: the keys, the plaintext, and the ciphertext beside it. */
const selectList = (table: string, definition: PiiTable): string => {
  const columns = new Set<string>(definition.keyColumns);
  for (const column of columnsOf(table)) {
    if (column.storage.kind === "digest") continue;
    columns.add(column.column);
    const sealedColumn = sealedColumnOf(column);
    if (sealedColumn) columns.add(sealedColumn);
    const index = indexColumnOf(column);
    if (index) columns.add(index);
  }
  return [...columns].join(",");
};

const keysOf = (definition: PiiTable, row: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(definition.keyColumns.map((column) => [column, String(row[column])]));

export async function resolveSubjectData(
  pool: PoolLike,
  principal: StaffPrincipal,
  input: { organisationId: string; subjectId: string; requestRef?: string },
  options: ResolveOptions,
): Promise<ResolvedSubject> {
  // Gated at the point of privilege rather than at the command above it (NZC-131).
  //
  // Reaching a person's rows is the identity question `subject.review` exists for. Reading them back in
  // the clear is a larger disclosure and has its own capability, checked *here* — so no caller can
  // obtain decrypted personal data by holding the milder one, whatever it chooses to call itself.
  //
  // There is deliberately no implication chain: `subject.export` does not confer `subject.review` and
  // neither confers `subject.erase`. The matrix decides which roles hold which.
  requireCapability(principal, options.decrypt ? "subject.export" : "subject.review");

  return withTenantWrite(pool, input.organisationId, async (db) => {
    const subject = await db.query<{ status: string }>(
      `SELECT status FROM nzi_console.data_subjects WHERE organisation_id=$1 AND subject_id=$2`,
      [input.organisationId, input.subjectId]);
    if (!subject.rows[0]) throw new Error(`No subject ${input.subjectId} in ${input.organisationId}.`);

    const keyRow = await db.query<{ wrapped_key: WrappedKey | null }>(
      `SELECT wrapped_key FROM nzi_console.data_subject_keys WHERE organisation_id=$1 AND subject_id=$2`,
      [input.organisationId, input.subjectId]);
    const keyPresent = Boolean(keyRow.rows[0]?.wrapped_key);

    let subjectKey: Buffer | null = null;
    if (options.decrypt && keyPresent) {
      const keys = options.keys ?? resolveSealingKeys();
      try {
        subjectKey = unwrapSubjectKey(keyRow.rows[0]!.wrapped_key, keys.masterKey);
      } catch (error) {
        if (!(error instanceof SubjectKeyShreddedError)) throw error;
      }
    }

    const links = await db.query<{ source_table: string; source_id: string }>(
      `SELECT source_table, source_id FROM nzi_console.data_subject_links
        WHERE organisation_id=$1 AND subject_id=$2 ORDER BY source_table, source_id`,
      [input.organisationId, input.subjectId]);

    const rows: ResolvedRow[] = [];
    const linkage: Array<{ sourceTable: string; sourceId: string; field: string }> = [];
    const considered = new Set<string>();

    for (const link of links.rows) {
      // Every table the inventory attributes to *this* linked person-row: the row itself, the tables
      // whose rows are its history, and the tables that point at it.
      for (const [table, definition] of Object.entries(PII_TABLES)) {
        const attribution = definition.attribution;
        const columns = columnsOf(table).filter((column) => isAttributable(column));
        if (columns.length === 0) continue;

        let where: string | null = null;
        let reach: ResolvedRow["reach"] | null = null;

        if (attribution.kind === "person-row" && attribution.subjectTable === link.source_table) {
          where = `${attribution.subjectIdColumn}=$2`;
          reach = "person-row";
        } else if (attribution.kind === "history-of" && PII_TABLES[attribution.table]) {
          const parent = PII_TABLES[attribution.table]!.attribution;
          if (parent.kind === "person-row" && parent.subjectTable === link.source_table) {
            where = `${parent.subjectIdColumn}=$2`;
            reach = "history-of";
          }
        } else if (attribution.kind === "pointer" && attribution.subjectTable === link.source_table) {
          where = `${attribution.via}=$2`;
          reach = "pointer";
        }
        if (!where || !reach) continue;
        considered.add(table);

        let found: { rows: Record<string, unknown>[] };
        // A savepoint, because a privilege refusal aborts the whole transaction and every statement
        // after it fails with "current transaction is aborted" — the same cascade that once hid a root
        // cause five subtests earlier. Rolling back to here keeps the refusal local to the one table.
        await db.query("SAVEPOINT reach");
        try {
          found = await db.query<Record<string, unknown>>(
            `SELECT ${selectList(table, definition)} FROM nzi_console.${table}
              WHERE organisation_id=$1 AND ${where}`,
            [input.organisationId, link.source_id]);
          await db.query("RELEASE SAVEPOINT reach");
        } catch (error) {
          await db.query("ROLLBACK TO SAVEPOINT reach");
          // A table this role cannot read is reported as unreadable, not skipped.
          //
          // `staff_credentials` is the case that found this: it is granted to `nzi_console_auth` alone,
          // so the tenant role this path runs under is refused — correctly. Dropping the table would
          // make an export quietly complete and an erasure quietly partial, which is the failure this
          // workstream exists to close. So the person is told their staff sign-in address is held and
          // could not be read here, and the gap is visible instead of absent.
          //
          // Only a privilege refusal is caught. Anything else is a fault and is raised.
          if ((error as { code?: string }).code !== "42501") throw error;
          rows.push({
            table, keys: {}, reach,
            data: columnsOf(table).map((column) => ({
              table: column.table, column: column.column, label: column.label,
              storage: column.storage.kind,
              unavailable: `held, but this path cannot read ${table}: it is granted to the authentication role alone`,
            })),
          });
          continue;
        }

        for (const row of found.rows) {
          rows.push({ table, keys: keysOf(definition, row), reach, data: readRow(columns, row, subjectKey, options) });
        }
      }

      // The digests this row holds, named rather than read. Which fields exist follows from the
      // inventory, so the confined table is never touched.
      const linkageTable = PII_TABLES[link.source_table]?.linkage;
      for (const column of columnsOf(link.source_table)) {
        if (column.storage.kind !== "sealed-and-indexed") continue;
        linkage.push({
          sourceTable: linkageTable?.table ?? link.source_table,
          sourceId: link.source_id,
          field: column.storage.linkageField,
        });
      }
    }

    const notAttributable = PII_COLUMNS.filter((column) => !isAttributable(column)).map((column) => {
      const attribution = attributionOf(column);
      return {
        table: column.table,
        column: column.column,
        label: column.label,
        because: attribution.kind === "none" || attribution.kind === "pending" ? attribution.because : "unstated",
      };
    });

    // Recorded as an act with counts, never with values — the audit of a subject access must not become
    // one more copy of the thing it is about.
    await db.query(
      `INSERT INTO nzi_console.audit_events
         (organisation_id,audit_event_id,actor_id,principal_type,action,entity_type,entity_id,correlation_id,after_json)
       VALUES ($1,$2,$3,'staff','subject.resolve','data_subject',$4,$5,$6::jsonb)`,
      [input.organisationId, `audit-${randomUUID()}`, principal.userId, input.subjectId,
        input.requestRef ?? input.subjectId,
        JSON.stringify({
          decrypted: options.decrypt, keyPresent, rows: rows.length,
          data: rows.reduce((total, row) => total + row.data.length, 0),
          linkage: linkage.length, notAttributable: notAttributable.length,
          requestRef: input.requestRef ?? null,
        })]);

    return {
      subjectId: input.subjectId,
      organisationId: input.organisationId,
      status: subject.rows[0].status,
      keyPresent,
      rows,
      linkage,
      notAttributable,
      tablesConsidered: [...considered].sort(),
      crossTenant: "not-answerable-here",
    };
  });
}

/** Every inventory column this path would reach for a subject — what a completeness proof compares against. */
export const reachableColumns = (): PiiColumn[] => PII_COLUMNS.filter(isAttributable);
