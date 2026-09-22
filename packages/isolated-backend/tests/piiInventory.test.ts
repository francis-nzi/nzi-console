import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attributableColumns, attributionOf, indexColumnOf, isAttributable, PII_COLUMNS, PII_TABLES,
  sealedColumnOf, unattributableColumns,
} from "../src/piiInventory";
import { SEALABLE_ROWS, SEALED_COLUMNS, UNSEALED_PII_FOUND } from "../src/piiSealing";
import { INDEXED_COLUMNS } from "../src/subjectCrypto";

/**
 * The inventory is one list, and these are the properties that keep it one (NZC-125).
 *
 * It replaced two hand-written lists whose agreement was asserted in a single direction: every column a
 * sealing descriptor filled had to appear in the column inventory. The direction that was not asserted
 * is where the gap lived — sixteen tables held personal data and six had a descriptor, so ten tables'
 * worth was unreachable from a subject and nothing anywhere said so.
 *
 * So both directions are asserted here, and every axis a consumer reads is required to be answered
 * rather than defaulted. The point is not tidiness: an export that silently omits a column tells
 * somebody they have seen everything, and an erasure that silently skips one tells them they are gone.
 */

describe("the PII inventory (NZC-125)", () => {
  it("has a table definition for every column, and a column for every table", () => {
    // Both directions. The first is what the old arrangement checked; the second is what it did not,
    // and is the one that would have shown the ten tables no subject path reached.
    const missingTable = PII_COLUMNS.filter((column) => !PII_TABLES[column.table]).map((c) => `${c.table}.${c.column}`);
    assert.deepEqual(missingTable, [], "a column names a table the inventory does not define");

    const columnTables = new Set(PII_COLUMNS.map((column) => column.table));
    const unusedTable = Object.keys(PII_TABLES).filter((table) => !columnTables.has(table));
    assert.deepEqual(unusedTable, [], "a table is defined but no column belongs to it");
  });

  it("answers every axis for every column, rather than defaulting one", () => {
    // A consumer reads all of these. A column that left one unstated would be handled by whatever the
    // reader assumed, which is how an omission becomes a silent one.
    for (const column of PII_COLUMNS) {
      const name = `${column.table}.${column.column}`;
      assert.ok(column.label.trim(), `${name} has no label, so an export cannot say what it is showing`);
      assert.ok(column.storage.kind, `${name} has no storage kind`);
      assert.ok(column.stage, `${name} has no sealing stage`);
      assert.ok(column.erasure, `${name} has no erasure treatment`);
    }
  });

  it("gives a reason wherever a datum cannot be reached from a subject", () => {
    // The axis the restructure exists for. "Not attributable" is a statement made to a person in their
    // export and recorded in their erasure, so it has to carry why.
    for (const column of unattributableColumns()) {
      const attribution = attributionOf(column);
      assert.ok(attribution.kind === "none" || attribution.kind === "pending", `${column.table} is neither`);
      assert.ok(attribution.because.trim(),
        `${column.table}.${column.column} is not attributable and does not say why`);
    }
  });

  it("matches erasure treatment to how the datum is actually stored", () => {
    // The pairing that has to hold or erasure promises something it cannot do: a key-shred only reaches
    // ciphertext, so anything without a ciphertext column needs a different answer, stated per column.
    for (const column of PII_COLUMNS) {
      const name = `${column.table}.${column.column}`;
      if (column.erasure === "shred-key") {
        assert.ok(sealedColumnOf(column),
          `${name} is to be key-shredded but has no ciphertext column to shred`);
      }
      if (column.erasure === "pending") {
        assert.ok(column.because?.trim(),
          `${name} is pending and must name the change that makes it erasable`);
      }
      if (column.erasure === "null-digest") {
        assert.equal(column.storage.kind, "digest", `${name} is nulled as a digest but is not one`);
      }
      if (column.erasure === "redact-or-retain") {
        assert.equal(column.storage.kind, "json",
          `${name} is redact-or-retain, which is the answer for a payload no key reaches`);
      }
      if (column.erasure === "not-attributable") {
        assert.ok(!isAttributable(column), `${name} claims no subject path but the inventory gives it one`);
      }
      if (column.erasure === "association-to-tombstone") {
        assert.equal(attributionOf(column).kind, "pointer",
          `${name} dangles to a tombstone, which is only meaningful for a pointer`);
      }
    }
  });

  it("names a real indexed column for everything it says is indexed", () => {
    // The blind index is domain-separated by column name, so a wrong name here would compute a digest
    // that matches nothing and a login that never succeeds.
    for (const column of PII_COLUMNS) {
      if (column.storage.kind !== "sealed-and-indexed") continue;
      assert.ok(column.storage.indexedAs in INDEXED_COLUMNS,
        `${column.table}.${column.column} indexes as ${column.storage.indexedAs}, which subjectCrypto does not know`);
      assert.equal(column.storage.indexedAs, `${column.table}.${column.column}`,
        "an indexed column's domain must be its own name, or two columns share a digest");
      assert.ok(column.storage.linkageField.trim(), "an indexed column needs the field its digest is recorded under");
    }
  });

  it("derives the sealing views without losing or inventing a column", () => {
    // `SEALED_COLUMNS` and `SEALABLE_ROWS` are views now. If a derivation drops something, the
    // seal-coverage invariant silently stops checking it — the exact failure this restructure removes.
    const withCiphertext = PII_COLUMNS.filter((column) => sealedColumnOf(column) !== null);
    assert.equal(SEALED_COLUMNS.length, withCiphertext.length);
    assert.deepEqual(
      SEALED_COLUMNS.map((c) => `${c.table}.${c.plaintext}`).sort(),
      withCiphertext.map((c) => `${c.table}.${c.column}`).sort());

    // A row is sealable when it is a person or the history of one. A pointer is not: it names somebody
    // whose identity lives in their own row and is sealed there, so sealing the pointer too would put a
    // second ciphertext of one person behind a key that shredding their record does not reach.
    const sealable = Object.entries(PII_TABLES)
      .filter(([, definition]) => definition.attribution.kind === "person-row"
        || definition.attribution.kind === "history-of").map(([table]) => table);
    assert.deepEqual(SEALABLE_ROWS.map((row) => row.table), sealable,
      "the sealable rows are exactly the people and their history, in inventory order");

    // History seals under its parent's subject, and the whole point of that is one key covering both.
    // If a history table ever resolved to a different subject column than the record it is history of,
    // shredding the person would leave their past readable.
    for (const [table, definition] of Object.entries(PII_TABLES)) {
      const attribution = definition.attribution;
      if (attribution.kind !== "history-of") continue;
      const child = SEALABLE_ROWS.find((row) => row.table === table)!;
      const parent = SEALABLE_ROWS.find((row) => row.table === attribution.table);
      assert.ok(parent, `${table} is history of ${attribution.table}, which is not itself sealable`);
      assert.equal(child.subjectTable, parent.subjectTable, `${table} must seal under its parent's subject`);
      assert.equal(child.subjectIdColumn, parent.subjectIdColumn);
    }

    for (const row of SEALABLE_ROWS) {
      const columns = PII_COLUMNS.filter((column) => column.table === row.table);
      assert.deepEqual(
        [...Object.keys(row.sealed), ...row.operational.map((field) => field.plaintext)].sort(),
        columns.filter((column) => sealedColumnOf(column)).map((column) => column.column).sort(),
        `${row.table}'s descriptor covers a different set of columns than the inventory lists`);
      for (const field of row.operational) {
        const column = columns.find((entry) => entry.column === field.plaintext)!;
        assert.equal(field.indexColumn, indexColumnOf(column));
      }
    }
  });

  it("carries the three things the old list could not", () => {
    // Stated as a floor rather than described, so removing one fails here rather than quietly narrowing
    // what an export gathers and an erasure destroys.
    assert.ok(PII_COLUMNS.some((column) => column.storage.kind === "digest"),
      "the linkage digest must be an entry: a key-shred leaves it behind, and a digest is confirmable by guess");
    assert.ok(Object.values(PII_TABLES).some((table) => table.history),
      "at least one table must map to where its history lives, or erasure shreds the present and leaves the past");
    assert.ok(PII_COLUMNS.some((column) => column.erasure === "redact-or-retain"),
      "personal data inside a JSON payload cannot be key-shredded and needs its own treatment");
  });

  it("keeps the unsealed view in step with the inventory", () => {
    const noCiphertext = PII_COLUMNS.filter(
      (column) => column.storage.kind === "json" || column.storage.kind === "digest");
    assert.deepEqual(
      UNSEALED_PII_FOUND.map((entry) => `${entry.table}.${entry.column}`).sort(),
      noCiphertext.map((column) => `${column.table}.${column.column}`).sort());
    for (const entry of UNSEALED_PII_FOUND) {
      assert.notEqual(entry.erasure, "shred-key", `${entry.table}.${entry.column} has no key to shred`);
    }
  });

  it("reports what it can and cannot reach, so the split is visible rather than inferred", () => {
    // Not an assertion about a number — a statement of the shape, which the next change to the
    // inventory will move. It fails if attribution stops being answered at all.
    const attributable = attributableColumns();
    const unattributable = unattributableColumns();
    assert.equal(attributable.length + unattributable.length, PII_COLUMNS.length);
    assert.ok(attributable.length > 0 && unattributable.length > 0,
      "both sides must be non-empty, or the axis has stopped meaning anything");
  });
});
