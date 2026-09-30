import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, defaultListQuery, fileTypeListSpec, validateCommand, type CommandContext, type FileTypeListQuery, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { createFileType, deactivateFileType, listFileTypesPage, reinstateFileType, updateFileType } from "../src/jobFileTypes";
import { withTenantRead, withTenantWrite } from "../src/postgres";

/**
 * Admin Phase C3: the job_file_type.* commands behind admin.lookups — the key set once and never updated (no field, no
 * grant), a system type never deactivated (SYSTEM_PROTECTED), a reason to deactivate, names and keys unique (inactive
 * included), versioned and idempotent, audited before and after — and the list the File types screen reads, with its
 * provenance and "in use: none yet", inside one organisation.
 */
type Issue = { field: string; code: string };
const issue = (field: string, code?: string) => (error: { issues?: Issue[] }) =>
  error.issues?.some((item) => item.field === field && (code === undefined || item.code === code)) === true;
const ctx = (reason?: string): CommandContext => ({ organisationId: "o", actorId: "a", principal: "staff", idempotencyKey: "k", correlationId: "c", ...(reason ? { reason } : {}),
  grant: commandGrantForRole("admin", "o", "a") });

describe("validating a file type (no database)", () => {
  it("takes a key only at create, lower-case with underscores — and a folder with hyphens", () => {
    const fields = (issues: Issue[]) => issues.map((item) => item.field);
    assert.deepEqual(fields(validateCommand("job_file_type.create", { fileTypeKey: "site_photos", displayName: "Site photos", storageFolderKey: "site-photos" }, ctx())), []);
    assert.deepEqual(fields(validateCommand("job_file_type.create", { fileTypeKey: "Site Photos", displayName: "Site photos", storageFolderKey: "site-photos" }, ctx())), ["fileTypeKey"]);
    assert.deepEqual(fields(validateCommand("job_file_type.create", { fileTypeKey: "x", displayName: " ", storageFolderKey: "Site_Photos" }, ctx())), ["fileTypeKey", "displayName", "storageFolderKey"]);
    assert.deepEqual(fields(validateCommand("job_file_type.update", { fileTypeId: "f", displayName: "Site photos", storageFolderKey: "site-photos", sortOrder: 1.5, expectedVersion: 1 }, ctx())), ["sortOrder"]);
  });

  it("asks a reason to deactivate, and none to reinstate", () => {
    assert.ok(validateCommand("job_file_type.deactivate", { fileTypeId: "f", expectedVersion: 1 }, ctx()).some((item) => item.field === "reason"));
    assert.deepEqual(validateCommand("job_file_type.deactivate", { fileTypeId: "f", expectedVersion: 1 }, ctx("No longer used")), []);
    assert.deepEqual(validateCommand("job_file_type.reinstate", { fileTypeId: "f", expectedVersion: 1 }, ctx()), []);
  });
});

describe("job file types, against the database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "net-zero-international"; // 0139 provisions the two system types here
  const OTHER = "ft-org-b";
  let database: DisposableDatabase;
  let keys = 0;
  const context = (org = ORG, role: StaffRole = "admin", reason?: string, idempotencyKey?: string): CommandContext => {
    keys += 1;
    return { organisationId: org, actorId: `${role}-${org}`, principal: "staff", idempotencyKey: idempotencyKey ?? `ft-${keys}`, correlationId: `corr-ft-${keys}`,
      ...(reason ? { reason } : {}), grant: commandGrantForRole(role, org, `${role}-${org}`) };
  };
  const listOf = (org = ORG, change: Partial<FileTypeListQuery> & { status?: string } = {}) => {
    const { status, ...rest } = change;
    const query: FileTypeListQuery = { ...defaultListQuery(fileTypeListSpec), ...rest, filters: status ? { status: [status] } : {} };
    return withTenantRead(database.pool, org, (db) => listFileTypesPage(db, query));
  };
  const row = async (key: string, org = ORG) => (await listOf(org)).rows.find((item) => item.key === key)!;
  const admin = async <T>(work: (db: import("pg").Client) => Promise<T>) => { const db = await database.admin(); try { return await work(db); } finally { await db.end(); } };

  before(async () => {
    database = (await createDisposableDatabase("filetypes"))!;
    await admin(async (db) => {
      await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [OTHER]);
      await db.query(`SELECT nzi_console.provision_organisation($1)`, [OTHER]);
      for (const org of [ORG, OTHER]) for (const role of ["admin", "consultant"]) {
        await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, $2, $3, 'active', $2)`, [org, `${role}-${org}`, role]);
      }
    });
  });
  after(async () => { await database?.end(); });

  it("lists the two provisioned system types, seeded, with no consumer yet", async () => {
    const page = await listOf();
    assert.deepEqual(page.rows.map((item) => [item.key, item.storageFolderKey, item.isSystem, item.provenance, item.inUse]),
      [["client_provided", "client-provided", true, "seeded", null], ["generated_report", "generated-reports", true, "seeded", null]]);
  });

  it("adds a type after the last, as 'added here', and audits what it became", async () => {
    const made = await createFileType(database.pool, { fileTypeKey: " site_photos ", displayName: "  Site   photos ", storageFolderKey: "site-photos" }, context());
    assert.match(made.data.fileTypeId, /^file-type:[0-9a-f-]{36}$/);
    const photos = await row("site_photos");
    assert.deepEqual([photos.displayName, photos.sortOrder, photos.isSystem, photos.provenance, photos.version], ["Site photos", 30, false, "added", 1]);
    const audit = await admin(async (db) => (await db.query(`SELECT action, entity_type, after_json FROM nzi_console.audit_events WHERE audit_event_id = $1`, [made.auditEventId])).rows[0]);
    assert.deepEqual([audit.action, audit.entity_type, audit.after_json.key, audit.after_json.isSystem], ["job_file_type.created", "job_file_type", "site_photos", false]);
  });

  it("replays an idempotent retry, and refuses a key or a name another type holds", async () => {
    const first = await createFileType(database.pool, { fileTypeKey: "drawings", displayName: "Drawings", storageFolderKey: "drawings" }, context(ORG, "admin", undefined, "ft-same"));
    const again = await createFileType(database.pool, { fileTypeKey: "drawings", displayName: "Drawings", storageFolderKey: "drawings" }, context(ORG, "admin", undefined, "ft-same"));
    assert.deepEqual([again.replayed, again.data.fileTypeId], [true, first.data.fileTypeId]);
    await assert.rejects(createFileType(database.pool, { fileTypeKey: "client_provided", displayName: "Other", storageFolderKey: "other" }, context()), issue("fileTypeKey", "DUPLICATE"));
    await assert.rejects(createFileType(database.pool, { fileTypeKey: "other", displayName: "site PHOTOS", storageFolderKey: "other" }, context()), issue("displayName", "DUPLICATE"));
  });

  it("is admin.lookups — a consultant cannot change a file type", async () => {
    await assert.rejects(createFileType(database.pool, { fileTypeKey: "mine", displayName: "Mine", storageFolderKey: "mine" }, context(ORG, "consultant")), /admin\.lookups|permission|capabilit/i);
  });

  it("edits the name, folder and order as a versioned change — never the key — and refuses a stale edit", async () => {
    const photos = await row("site_photos");
    const edited = await updateFileType(database.pool, { fileTypeId: photos.fileTypeId, displayName: "Site photographs", storageFolderKey: "site-photographs", sortOrder: 25, expectedVersion: 1 }, context());
    assert.deepEqual([edited.data.version, edited.data.key, edited.data.storageFolderKey], [2, "site_photos", "site-photographs"]);
    const audit = await admin(async (db) => (await db.query(`SELECT before_json, after_json FROM nzi_console.audit_events WHERE audit_event_id = $1`, [edited.auditEventId])).rows[0]);
    assert.deepEqual([audit.before_json.displayName, audit.after_json.displayName], ["Site photos", "Site photographs"]);
    // An update carrying a key is ignored: the key is not an update field, and the role could not write it anyway.
    await updateFileType(database.pool, { fileTypeId: photos.fileTypeId, displayName: "Site photographs", storageFolderKey: "site-photographs", sortOrder: 25, expectedVersion: 2, ...({ fileTypeKey: "renamed" } as object) }, context());
    assert.equal((await row("site_photos")).key, "site_photos");
    await assert.rejects(withTenantWrite(database.pool, ORG, (db) => db.query(`UPDATE nzi_console.job_file_types SET file_type_key = 'renamed' WHERE file_type_id = $1`, [photos.fileTypeId])), /permission denied/);
    await assert.rejects(updateFileType(database.pool, { fileTypeId: photos.fileTypeId, displayName: "X", storageFolderKey: "x", expectedVersion: 1 }, context()), /version|changed/i);
  });

  it("never deactivates a system type (SYSTEM_PROTECTED); deactivates others only with a reason, never deletes — and reinstates", async () => {
    const system = await row("client_provided");
    await assert.rejects(deactivateFileType(database.pool, { fileTypeId: system.fileTypeId, expectedVersion: system.version }, context(ORG, "admin", "Tidying")), issue("fileTypeId", "SYSTEM_PROTECTED"));
    const drawings = await row("drawings");
    await assert.rejects(deactivateFileType(database.pool, { fileTypeId: drawings.fileTypeId, expectedVersion: 1 }, context()), issue("reason"));
    const done = await deactivateFileType(database.pool, { fileTypeId: drawings.fileTypeId, expectedVersion: 1 }, context(ORG, "admin", "Folded into site photographs"));
    assert.deepEqual([done.data.active, done.data.version], [false, 2]);
    assert.equal((await listOf(ORG, { status: "inactive" })).rows.map((item) => item.key).join(), "drawings", "still listed — deactivated, not deleted");
    await assert.rejects(createFileType(database.pool, { fileTypeKey: "drawings_2", displayName: "DRAWINGS", storageFolderKey: "drawings" }, context()), issue("displayName", "DUPLICATE"), "an inactive type keeps its name");
    const back = await reinstateFileType(database.pool, { fileTypeId: drawings.fileTypeId, expectedVersion: 2 }, context());
    assert.deepEqual([back.data.active, back.data.version], [true, 3]);
    await assert.rejects(reinstateFileType(database.pool, { fileTypeId: drawings.fileTypeId, expectedVersion: 3 }, context()), issue("fileTypeId", "ALREADY_ACTIVE"));
  });

  it("counts the segment from the data, searches name and key, and sorts by the types' own order", async () => {
    const page = await listOf();
    assert.deepEqual(page.filterOptions.status.map((option) => [option.value, option.count]), [["active", 4], ["inactive", 0]]);
    assert.deepEqual(page.rows.map((item) => item.key), ["client_provided", "generated_report", "site_photos", "drawings"]);
    assert.deepEqual((await listOf(ORG, { search: "photo" })).rows.map((item) => item.key), ["site_photos"]);
  });

  it("never reaches another organisation's file type, and each organisation has its own keys", async () => {
    const theirs = await createFileType(database.pool, { fileTypeKey: "site_photos", displayName: "Site photos", storageFolderKey: "site-photos" }, context(OTHER));
    await assert.rejects(updateFileType(database.pool, { fileTypeId: theirs.data.fileTypeId, displayName: "Hijacked", storageFolderKey: "x", expectedVersion: 1 }, context()), issue("fileTypeId", "NOT_FOUND"));
    assert.deepEqual((await listOf(OTHER)).rows.map((item) => item.key), ["site_photos"], "B has only its own — no system types were provisioned for it");
  });
});
