import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { getClientLogo, setClientLogo } from "../src/clientLogo";
import { withTenantRead } from "../src/postgres";
import { listAllJobs } from "../src/readModels";

/**
 * The widened client logo store (CLIENT-02, 0153) against a real database: a JPEG and a WebP are stored through
 * client.logo.set and served back; the CHECK still refuses any other type; the organisation's own logo store (0142) is
 * unchanged; and a job carries its client's logo for its header.
 */
const ORG = "logo-org";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x1a, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.from([0, 0, 0, 0])]);
const SHA = "a".repeat(64);

describe("the widened client logo store (0153), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let counter = 0;
  const context = (actor: string, role: StaffRole): CommandContext => {
    counter += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `logo-${counter}`, correlationId: `corr-logo-${counter}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };

  before(async () => {
    database = (await createDisposableDatabase("clientlogo"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada Admin')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, 'client-a', 'Acme', 'active')`, [ORG]);
  });
  after(async () => { await database?.end(); });

  it("stores a JPEG and a WebP through client.logo.set, and serves the current one back with its type", async () => {
    await setClientLogo(database.pool, { clientId: "client-a", fileName: "acme.jpg", contentType: "image/jpeg", dataBase64: JPEG.toString("base64") }, context("ada", "admin"));
    await setClientLogo(database.pool, { clientId: "client-a", fileName: "acme.webp", contentType: "image/webp", dataBase64: WEBP.toString("base64") }, context("ada", "admin"));
    const types = (await q(`SELECT content_type FROM nzi_console.client_logo_assets WHERE client_id = 'client-a' ORDER BY uploaded_at, file_name`)).map((row) => row.content_type);
    assert.deepEqual(types.sort(), ["image/jpeg", "image/webp"]);
    const current = await withTenantRead(database.pool, ORG, (db) => getClientLogo(db, "client-a"));
    assert.equal(current?.contentType, "image/webp");
    assert.deepEqual(current?.content, WEBP);
  });

  it("still refuses any other type at the database, and leaves the organisation's own logo store PNG or SVG", async () => {
    const insert = (table: string, type: string, extra: string, values: unknown[]) => q(
      `INSERT INTO nzi_console.${table} (organisation_id, asset_id, ${extra}file_name, content_type, byte_size, sha256, content, uploaded_by) VALUES ($1, $2, ${values.map((_, index) => `$${index + 5}, `).join("")}'x', $3, 4, $4, '\\x00'::bytea, 'ada')`,
      [ORG, `asset-${table}-${type}`, type, SHA, ...values]);
    await assert.rejects(insert("client_logo_assets", "image/gif", "client_id, ", ["client-a"]), /client_logo_assets_content_type_check/);
    await insert("client_logo_assets", "image/jpeg", "client_id, ", ["client-a"]);
    await assert.rejects(insert("organisation_logo_assets", "image/jpeg", "", []), /organisation_logo_assets_content_type_check/);
  });

  it("carries the client's current logo on each of its jobs, for the job header", async () => {
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, owner_name, start_date, due_date, progress_percent, detail_json, version)
      VALUES ($1, 'job-a', 'client-a', 900001, 'consultancy', 'Advisory', 'open', 'scoping', 'Ada Admin', '2026-01-01', '2026-12-31', 0,
        '{"kind":"consultancy","engagement":"Advisory","workstreams":1,"deliverables":1,"hoursLogged":0,"budgetHours":1}'::jsonb, 1)`, [ORG]);
    const [job] = await withTenantRead(database.pool, ORG, (db) => listAllJobs(db));
    const [{ logo_asset_id: current }] = await q(`SELECT logo_asset_id FROM nzi_console.clients WHERE client_id = 'client-a'`);
    assert.equal(job?.header.clientLogoAssetId, current);
  });
});
