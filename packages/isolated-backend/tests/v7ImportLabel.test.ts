import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { CONSOLIDATED_ON_READ, KNOWN_DATA_SOURCES } from "../src/v7ClientImport";
import { sanitiseV7ImportLabel, V7_IMPORT_LABEL_DEFAULTS, V7_IMPORT_LABEL_PII_PATTERNS, v7ImportLabelHasPii } from "../src/v7ImportLabel";
import { V7_IMPORT_VIEW_CONTRACT, V7ImportViewConnectionRefused, v7ImportViewPoolConfig } from "../src/v7ImportView";
import { LABEL_FIXTURES, PII_FIXTURES } from "./support/v7ImportLabelFixtures";

/** The import's label rule (R-1) and the view set's SQL, without a database: the TypeScript half, and the SQL's text. */
const SQL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "v7-source", "v7_import_views.sql"), "utf8");

describe("the label rule (R-1), TypeScript half", () => {
  for (const fixture of LABEL_FIXTURES) {
    it(fixture.why, () => assert.equal(sanitiseV7ImportLabel(fixture.value, fixture.allowed, fixture.context), fixture.expected));
  }
  it("matches each PII shape, and leaves taxonomy text alone", () => {
    for (const { value, pii } of PII_FIXTURES) assert.equal(v7ImportLabelHasPii(value), pii, value);
  });
  it("never puts out a label that matches a pattern", () => {
    for (const fixture of LABEL_FIXTURES) assert.equal(v7ImportLabelHasPii(sanitiseV7ImportLabel(fixture.value, fixture.allowed, fixture.context)), false, fixture.why);
  });
});

describe("the view set's SQL says what the TypeScript says", () => {
  it("carries every pattern verbatim, case-insensitive exactly where the TypeScript is", () => {
    for (const pattern of V7_IMPORT_LABEL_PII_PATTERNS) {
      const operator = pattern.insensitive ? "~*" : "~ ";
      assert.ok(SQL.includes(`value ${operator} '${pattern.source}'`), `${pattern.name}: value ${operator} '${pattern.source}'`);
    }
  });
  it("allow-lists the same fixed labels", () => {
    for (const label of V7_IMPORT_LABEL_DEFAULTS) assert.ok(SQL.includes(`('${label}')`), label);
  });
  it("passes through exactly the data sources the planner knows, in both views", () => {
    for (const source of [...KNOWN_DATA_SOURCES, ...CONSOLIDATED_ON_READ]) {
      assert.equal(SQL.split(`'${source}'`).length - 1, 2, `${source} appears in scope_rows and emission_sources`);
    }
  });
  it("creates every view the contract names, and grants SELECT on each", () => {
    for (const view of Object.keys(V7_IMPORT_VIEW_CONTRACT)) {
      assert.ok(SQL.includes(`CREATE VIEW v7_import.${view} AS`), view);
      assert.match(SQL, new RegExp(`GRANT SELECT ON [^;]*v7_import\\.${view}[,\\s]`), `${view} is granted`);
    }
  });
  it("never selects a row's notes, a name or an address into a view", () => {
    for (const column of ["client_name", "site_name", "location", "full_name", "email", "spend_description", "source_name", "employee_name", "r.notes,", "title"]) {
      assert.ok(!new RegExp(`SELECT[^;]*\\b${column.replace(".", "\\.")}`, "s").test(SQL.replace(/--.*$/gm, "").replace(/substring\(r\.notes[^)]*\)/g, "")), column);
    }
  });
});

describe("the service's one connection to the view set", () => {
  const URL = "postgresql://cc_import_view.ref:secret@aws-0-eu-west-2.pooler.supabase.com:5432/postgres";
  it("needs NZI_V7_VIEW_URL, with no fallback", () => {
    assert.throws(() => v7ImportViewPoolConfig({}), V7ImportViewConnectionRefused);
    assert.throws(() => v7ImportViewPoolConfig({ NZI_ISOLATED_DATABASE_URL: URL }), V7ImportViewConnectionRefused);
  });
  it("refuses the console's own database", () => {
    assert.throws(() => v7ImportViewPoolConfig({ NZI_V7_VIEW_URL: URL, NZI_ISOLATED_DATABASE_URL: URL.replace("cc_import_view.ref", "postgres.ref"), NZI_V7_VIEW_CA_CERT: "-----BEGIN CERTIFICATE-----x" }),
      /console's own database/);
  });
  it("needs verified TLS off-machine, and is read-only on the wire", () => {
    assert.throws(() => v7ImportViewPoolConfig({ NZI_V7_VIEW_URL: URL }), /TLS|CA|certificate/i);
    const config = v7ImportViewPoolConfig({ NZI_V7_VIEW_URL: URL, NZI_V7_VIEW_CA_CERT: "-----BEGIN CERTIFICATE-----x" });
    assert.deepEqual([config.options, config.max], ["-c default_transaction_read_only=on", 2]);
  });
});
