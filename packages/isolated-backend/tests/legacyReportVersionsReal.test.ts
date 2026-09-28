import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import {
  LegacyReportHashMismatchError, openLegacyReport, sealLegacyReport, sha256Hex, type SealedLegacyReport,
} from "../src/legacyReportSeal";
import { PII_COLUMNS } from "../src/piiInventory";
import { SEALED_COLUMNS } from "../src/piiSealing";
import { ContentKeyShreddedError } from "../src/subjectCrypto";
import { planColumn } from "../src/subjectErasure";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * v7's report versions as imported (0135; docs/CLIENT_JOB_IMPORT_DESIGN.md §5.2, §7; decision 10, NZC-166): each
 * sealed whole under its own content key wrapped by the master key, hash-verified against v7's data_hash, append-
 * only, tenant-confined — and not a data subject. Synthetic payloads only; the names in them are invented.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "net-zero-international";
const V7 = "nzi-pro-v7";
const MASTER = () => process.env.NZI_SUBJECT_MASTER_KEY!;

// v7 serialises with sort_keys and ensure_ascii=False; the bytes are what matter, so the text is used as is.
const SNAPSHOT = '{"generation_date": "2024-03-01", "prepared_by": "Ada Example", "scope_totals": {"1": 12.5, "2": 40.1}}';

describe("v7 report versions: sealed, hash-verified records of account (0135)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let ids = 0;

  const insert = (sealed: SealedLegacyReport | null, over: Record<string, unknown> = {}) => {
    ids += 1;
    const row = {
      legacy_report_id: `lrv-${ids}`, kind: "report", legacy_db_id: `${ids}`, version_number: 1, legacy_status: "final",
      v7_data_hash: sealed?.payloadSha256 ?? null, payload_sha256: sealed?.payloadSha256 ?? null,
      payload_sealed: sealed?.payloadSealed ?? null, particulars_sealed: sealed?.particularsSealed ?? null,
      content_key_wrapped: sealed?.contentKeyWrapped ?? null, ...over,
    };
    return db.query(
      `INSERT INTO nzi_console.legacy_report_versions
         (organisation_id,legacy_report_id,job_id,kind,source_system,legacy_db_id,version_number,legacy_status,report_format,
          is_portal_version,storage_provider,v7_data_hash,payload_sha256,payload_sealed,particulars_sealed,content_key_wrapped,imported_by)
       VALUES ($1,$2,'job-v7-612',$3,$4,$5,$6,$7,'pdf',false,'onedrive',$8,$9,$10,$11,$12,'import:test')`,
      [ORG, row.legacy_report_id, row.kind, V7, row.legacy_db_id, row.version_number, row.legacy_status, row.v7_data_hash,
        row.payload_sha256, json(row.payload_sealed), json(row.particulars_sealed), json(row.content_key_wrapped)])
      .then(() => row.legacy_report_id as string);
  };
  const json = (value: unknown) => (value === null || value === undefined ? null : JSON.stringify(value));
  const sealed = () => sealLegacyReport({
    payloadText: SNAPSHOT, v7DataHash: sha256Hex(SNAPSHOT),
    particulars: { generatedBy: "ada@example.invalid", finalizedBy: "bo@example.invalid", externalWebUrl: "https://example.invalid/personal/ada/r.pdf" },
  }, MASTER());
  const stored = async (id: string) => (await db.query(
    `SELECT payload_sealed, payload_sha256, particulars_sealed, content_key_wrapped FROM nzi_console.legacy_report_versions WHERE legacy_report_id=$1`, [id])).rows[0];

  before(async () => {
    database = (await createDisposableDatabase("legacyreports"))!;
    db = await database.admin();
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status,source_system,legacy_db_id) VALUES ($1,'client-v7-1','Synthetic Co','active',$2,'1')`, [ORG, V7]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,source_system,legacy_db_id,legacy_job_number)
       VALUES ($1,'job-v7-612','client-v7-1',612,'crp','CRP 2023','complete','Completed',2023,$2,'4012','J000612')`, [ORG, V7]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  // ── Sealing and the hash ───────────────────────────────────────────────────────────────────────────────

  it("stores the payload only as ciphertext, and opens it back byte for byte with its particulars", async () => {
    const id = await insert(sealed());
    const raw = await db.query<{ text: string }>(`SELECT to_jsonb(v)::text AS text FROM nzi_console.legacy_report_versions v WHERE legacy_report_id=$1`, [id]);
    assert.doesNotMatch(raw.rows[0]!.text, /Ada Example|ada@example|personal\/ada/, "a name reached the table in the clear");
    const opened = openLegacyReport(await stored(id), MASTER());
    assert.equal(opened.payloadText, SNAPSHOT);
    assert.equal(opened.particulars?.finalizedBy, "bo@example.invalid");
  });

  it("gives every version its own content key", async () => {
    const [a, b] = [sealed(), sealed()];
    assert.notDeepEqual(a.contentKeyWrapped, b.contentKeyWrapped);
    const id = await insert(b);
    const withOtherKey = { ...(await stored(id)), content_key_wrapped: a.contentKeyWrapped };
    assert.throws(() => openLegacyReport(withOtherKey, MASTER()), "one report's key opened another's payload");
  });

  it("refuses a payload that does not hash to what v7 stated — at sealing and in the table", async () => {
    assert.throws(() => sealLegacyReport({ payloadText: SNAPSHOT + " ", v7DataHash: sha256Hex(SNAPSHOT), particulars: {} }, MASTER()),
      LegacyReportHashMismatchError);
    const good = sealed();
    await assert.rejects(insert(good, { v7_data_hash: sha256Hex("something else") }), /legacy_report_versions_hash_verified/);
    await assert.rejects(insert(good, { payload_sha256: null }), /legacy_report_versions_hash_verified/, "v7 stated a hash for a payload with no digest");
    await assert.rejects(insert(good, { payload_sha256: null, v7_data_hash: null }), /legacy_report_versions_payload_shape/);
    // And on opening: a stored digest that no longer matches the bytes is refused, not shown.
    const kept = await stored(await insert(sealed()));
    assert.throws(() => openLegacyReport({ ...kept, payload_sha256: sha256Hex("tampered") }, MASTER()), LegacyReportHashMismatchError);
  });

  it("records a version v7 kept no snapshot for, as absent rather than refused", async () => {
    const empty = sealLegacyReport({ payloadText: null, v7DataHash: null, particulars: { notes: "no snapshot" } }, MASTER());
    const id = await insert(empty);
    assert.deepEqual(openLegacyReport(await stored(id), MASTER()), { payloadText: null, particulars: { notes: "no snapshot" } });
  });

  // ── Shape and identity ─────────────────────────────────────────────────────────────────────────────────

  it("numbers a report version and not the LCA result; keys each by v7 id per kind", async () => {
    await assert.rejects(insert(sealed(), { version_number: null }), /legacy_report_versions_numbered/);
    await assert.rejects(insert(sealed(), { kind: "lca-result" }), /legacy_report_versions_numbered/);
    await insert(sealed(), { kind: "lca-result", version_number: null, legacy_db_id: "900", legacy_status: "complete" });
    await insert(sealed(), { legacy_db_id: "900" });
    await assert.rejects(insert(sealed(), { legacy_db_id: "900" }), /legacy_report_versions_import_identity_key/);
    await assert.rejects(insert(sealed(), { content_key_wrapped: null }), /legacy_report_versions_key_shape/);
  });

  // ── Append-only, with the one reserved change ──────────────────────────────────────────────────────────

  it("refuses every change and every delete, even to the owner", async () => {
    const id = await insert(sealed());
    await assert.rejects(db.query(`UPDATE nzi_console.legacy_report_versions SET legacy_status='review' WHERE legacy_report_id=$1`, [id]), /immutable records of account/);
    await assert.rejects(db.query(`UPDATE nzi_console.legacy_report_versions SET is_portal_version=true WHERE legacy_report_id=$1`, [id]), /immutable records of account/);
    await assert.rejects(db.query(`DELETE FROM nzi_console.legacy_report_versions WHERE legacy_report_id=$1`, [id]), /never deleted/);
    await assert.rejects(db.query(
      `UPDATE nzi_console.legacy_report_versions SET content_key_wrapped=NULL, content_key_shredded_at=now(), content_key_shredded_by='x', legacy_status='gone'
        WHERE legacy_report_id=$1`, [id]), /immutable records of account/, "a shred carried another change with it");
  });

  it("allows only the reserved key-shred, after which the report can be read by no one", async () => {
    const id = await insert(sealed());
    await db.query(
      `UPDATE nzi_console.legacy_report_versions SET content_key_wrapped=NULL, content_key_shredded_at=now(), content_key_shredded_by='staff:test'
        WHERE legacy_report_id=$1`, [id]);
    const shredded = await stored(id);
    assert.throws(() => openLegacyReport(shredded, MASTER()), ContentKeyShreddedError);
    const kept = await db.query(`SELECT payload_sha256 FROM nzi_console.legacy_report_versions WHERE legacy_report_id=$1`, [id]);
    assert.equal(kept.rows[0]!.payload_sha256, sha256Hex(SNAPSHOT), "the digest survives, so the record still proves what it was");
  });

  // ── The application role and the tenant ───────────────────────────────────────────────────────────────

  it("grants the application role SELECT and INSERT only, confined to its tenant", async () => {
    const grants = await db.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema='nzi_console' AND table_name='legacy_report_versions' AND grantee='nzi_console_app' ORDER BY 1`);
    assert.deepEqual(grants.rows.map((row) => row.privilege_type), ["INSERT", "SELECT"]);

    const app = await database.admin();
    try {
      await app.query(`SET ROLE nzi_console_app`);
      await app.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
      const mine = await app.query(`SELECT count(*)::int AS n FROM nzi_console.legacy_report_versions`);
      assert.ok(mine.rows[0]!.n > 0);
      await assert.rejects(app.query(`UPDATE nzi_console.legacy_report_versions SET legacy_status='x'`), /permission denied/);
      await assert.rejects(app.query(`DELETE FROM nzi_console.legacy_report_versions`), /permission denied/);
      await app.query(`SELECT set_config('app.organisation_id', 'another-organisation', false)`);
      const theirs = await app.query(`SELECT count(*)::int AS n FROM nzi_console.legacy_report_versions`);
      assert.equal(theirs.rows[0]!.n, 0, "another tenant saw this organisation's reports");
    } finally {
      await app.end();
    }
  });

  // ── Not a data subject (decision 10) ───────────────────────────────────────────────────────────────────

  it("registers no subject, and erasing a person retains the report on its stated basis", async () => {
    const subjects = await db.query(`SELECT 1 FROM nzi_console.data_subject_links WHERE source_table='legacy_report_versions'`);
    assert.equal(subjects.rowCount, 0);
    assert.ok(!SEALED_COLUMNS.some((column) => column.table === "legacy_report_versions"),
      "a report's content would be sealed under a person's key and shredded with them");

    for (const column of PII_COLUMNS.filter((entry) => entry.table === "legacy_report_versions")) {
      const planned = planColumn(column, { rows: 0, readable: true, considered: false });
      assert.equal(planned?.outcome, "retained", `${column.column} must be retained, never reported as nothing held`);
      assert.match(planned!.because, /legacy-report-records-of-account/);
      if (column.storage.kind === "document-sealed") {
        const exists = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='nzi_console'
          AND table_name='legacy_report_versions' AND column_name = ANY($1::text[])`, [[column.column, column.storage.keyColumn]]);
        assert.equal(exists.rowCount, 2, `${column.column} or its key column does not exist`);
      }
    }
  });
});
