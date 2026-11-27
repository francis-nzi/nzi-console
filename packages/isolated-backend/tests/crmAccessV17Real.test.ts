import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { commandDefinitions, CONSULTANT_WITHHELD, maySelfApprove, PERMISSION_MATRIX_VERSION, roleCapabilityGrants, type Capability, type CommandContext, type CommandGrant, type CommandKey } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { assertCapabilityOnClient, authorizeCommandInTransaction, requireConditionalCapability } from "../src/access";
import { AuthorizationError, capabilitiesFromRows } from "../src/auth";
import { clientHistoryFor } from "../src/clientHistory";
import { auditEventsFor } from "../src/readModels";
import { readJobTimeSummary } from "../src/timeEntries";
import { personContext } from "../src/v7BatchAttest";
import { withTenantRead } from "../src/postgres";

/**
 * The CRM access matrix (v17, 0241; Francis 27 Nov; _handoff/AUDIT-crm-access.md), against a real database: the grant is the one
 * the database serves for a Consultant (staff_role_capabilities, the latest version), and every check runs the real access probe
 * over real rows, as nzi_console_app under the tenant policy.
 *
 * The actor is consultant-a; every record belongs to a client consultant-b owns — a colleague's client, the case v16 refused.
 * - (a) and (b): each audit row's command passes the runner's check (capability, tenant, and no own-clients refusal), and the
 *   non-command gates (portal admin, a client's history, others' time on a job, the conditional re-baseline, batch attest) open.
 * - (c): job.fee.set, time.entry.bill and staff.capacity.set are refused, as is every command under a withheld capability; the
 *   organisation-wide audit feed stays the consultant's own clients'; the book runner has no route from the app.
 */
const ORG = "crm17-org", OWNER = "consultant-b", ACTOR = "consultant-a", CLIENT = "crm17-client", JOB = "crm17-job", SITE = "crm17-site";
const SNAPSHOT = "crm17-snap", REPORT = "crm17-rv", RUN = "crm17-run";
const here = dirname(fileURLToPath(import.meta.url));

/** Every id field the audited commands name a subject by, each a record on the colleague's client. */
const subjectIds = { clientId: CLIENT, jobId: JOB, siteId: SITE, reviewedSnapshotId: SNAPSHOT, reportVersionId: REPORT, courseRunId: RUN };

/** The audit's (a) and (b) rows that are commands, by row number. (#7 client deactivate has no command; its grant is checked below.) */
const OPEN_ROWS: Array<[number, CommandKey[]]> = [
  [1, ["client.update"]],
  [2, ["portal.access.grant"]],
  [3, ["client.portal.profile.set"]],
  [4, ["client.file.deliver", "client.file.download", "client.file.rescan", "client.file.deactivate"]],
  [5, ["client.category.visibility.set", "client.portal.scope.visibility.set"]],
  [9, ["dataset.override.add"]],
  [14, ["v7.reingest.job"]],
  [15, ["v7.reingest.revert"]],
  [17, ["scope.review.attest_reingest"]],
  [19, ["assurance.gap.resolve"]],
  [20, ["scope.review.approve", "scope.review.reject"]],
  [21, ["report.snapshot.approve"]],
  [22, ["lca.assessment.review.approve", "lca.assessment.review.reject"]],
  [23, ["training.run.review"]],
  [24, ["emissions.target.upsert"]],
  [25, ["report.validate"]],
  [26, ["report.sectionPlan.update"]],
  [27, ["report.publish"]],
  [28, ["time.entry.log"]],
];
/** Rows 8, 10, 11 and 12: every command under the capability, so a command added to it later is covered too. */
const OPEN_BY_CAPABILITY: Array<[number, Capability]> = [[8, "factor.manage"], [10, "admin.lookups"], [11, "admin.lookups"], [12, "admin.templates"]];
/** The audit's (c) rows that are commands. */
const RESTRICTED_ROWS: Array<[number, CommandKey]> = [[13, "job.fee.set"], [30, "time.entry.bill"], [31, "staff.capacity.set"]];

const commandsUnder = (capability: Capability) =>
  Object.values(commandDefinitions).filter((definition) => (definition as { permission: string }).permission === capability).map((definition) => definition.key as CommandKey);

describe("the CRM access matrix (v17): a consultant on a colleague's client, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let grant: CommandGrant;
  let count = 0;
  const context = (): CommandContext => { count += 1; return { organisationId: ORG, actorId: ACTOR, principal: "staff", idempotencyKey: `crm17-${count}`, correlationId: `corr-crm17-${count}`, grant, reason: "CRM access matrix v17 check" }; };
  const holder = () => ({ organisationId: ORG, userId: ACTOR, capabilities: grant.capabilities });
  const authorize = (key: CommandKey) => withTenantRead(database.pool, ORG, (db) => authorizeCommandInTransaction(db, key, subjectIds as never, context()));

  before(async () => {
    database = (await createDisposableDatabase("crmaccessv17"))!;
    const db = await database.admin();
    try {
      await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
      await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
      for (const [user, role] of [[ACTOR, "consultant"], [OWNER, "consultant"], ["crm17-admin", "admin"]]) {
        await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,$3,'active') ON CONFLICT (organisation_id,user_id) DO NOTHING`, [ORG, user, role]);
      }
      await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status,owner_user_id) VALUES ($1,$2,'Colleague Co','active',$3)`, [ORG, CLIENT, OWNER]);
      await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage) VALUES ($1,$2,$3,917001,'crp','CRP','open','Setup')`, [ORG, JOB, CLIENT]);
      await db.query(`INSERT INTO nzi_console.client_sites (organisation_id,client_id,site_id,name,created_by,archived) VALUES ($1,$2,$3,'HQ','seed',false)`, [ORG, CLIENT, SITE]);
      const hash = `sha256:${createHash("sha256").update(SNAPSHOT).digest("hex")}`;
      await db.query(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by)
                      VALUES ($1, $2, $3, 1, 1, $4, '{}'::jsonb, $5)`, [ORG, SNAPSHOT, JOB, hash, OWNER]);
      await db.query(`INSERT INTO nzi_console.report_versions (organisation_id, report_version_id, job_id, status, manifest_version, reviewed_snapshot_id, data_hash)
                      VALUES ($1, $2, $3, 'validated', 1, $4, $5)`, [ORG, REPORT, JOB, SNAPSHOT, hash]);
      await db.query(`INSERT INTO nzi_console.training_course_runs (organisation_id,course_run_id,job_id,run_name,workflow_stage_key,created_by) VALUES ($1,$2,$3,'Carbon Literacy','certified','seed')`, [ORG, RUN, JOB]);
      // Two audit events: one on the colleague's client, one on a client the actor owns.
      await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status,owner_user_id) VALUES ($1,'crm17-own','Own Co','active',$2)`, [ORG, ACTOR]);
      for (const [id, client] of [["ae-colleague", CLIENT], ["ae-own", "crm17-own"]]) {
        await db.query(`INSERT INTO nzi_console.audit_events (organisation_id,audit_event_id,actor_id,principal_type,action,entity_type,entity_id,client_id,correlation_id)
                        VALUES ($1,$2,$3,'staff','client.update','client',$4,$4,$2)`, [ORG, id, OWNER, client]);
      }
      // The grant the database serves for a Consultant: the latest matrix version's rows, as resolveStaffPrincipal reads them.
      const { rows } = await db.query<{ matrix_version: number; capability: string; scope: string }>(
        `SELECT matrix_version, capability, scope FROM nzi_console.staff_role_capabilities
          WHERE role_id = 'consultant' AND matrix_version = (SELECT max(matrix_version) FROM nzi_console.staff_capability_matrix_versions)`);
      const served = capabilitiesFromRows(rows);
      grant = { organisationId: ORG, userId: ACTOR, role: "consultant", matrixVersion: served.matrixVersion, capabilities: served.capabilities };
    } finally { await db.end(); }
  });
  after(async () => { await database?.end(); });

  it("serves matrix v17 for the Consultant: Admin less the withheld list, everything at all — the same rows as the code", () => {
    assert.equal(grant.matrixVersion, PERMISSION_MATRIX_VERSION);
    assert.equal(grant.matrixVersion, 17);
    const sorted = (grants: readonly { capability: string; scope: string }[]) => grants.map((g) => `${g.capability} ${g.scope}`).sort();
    assert.deepEqual(sorted(grant.capabilities), sorted(roleCapabilityGrants("consultant")));
    assert.ok(grant.capabilities.every((g) => g.scope === "all"), "no own-clients grant is left");
    for (const capability of CONSULTANT_WITHHELD) assert.ok(!grant.capabilities.some((g) => g.capability === capability), capability);
    assert.ok(grant.capabilities.some((g) => g.capability === "client.deactivate"), "#7: client.deactivate is held (no command is wired)");
  });

  for (const [row, keys] of OPEN_ROWS) {
    it(`(a/b) #${row}: ${keys.join(", ")} — passes the runner's check on the colleague's client`, async () => {
      for (const key of keys) {
        const access = await authorize(key);
        assert.equal(access?.clientId, CLIENT, key);
        assert.equal(access?.ownedByActor, false, `${key}: the record is the colleague's`);
      }
    });
  }

  for (const [row, capability] of OPEN_BY_CAPABILITY) {
    it(`(b) #${row}: every ${capability} command passes the runner's check`, async () => {
      const keys = commandsUnder(capability);
      assert.ok(keys.length > 0, capability);
      for (const key of keys) {
        try { await authorize(key); }
        catch (error) { assert.fail(`${key}: ${(error as Error).message}`); }
      }
    });
  }

  it("(b) #1, #24: the conditional re-baseline is held on the colleague's client", async () => {
    const access = await withTenantRead(database.pool, ORG, (db) => authorizeCommandInTransaction(db, "client.update", subjectIds as never, context()));
    assert.doesNotThrow(() => requireConditionalCapability(context(), "baseline.rebaseline", access));
    const jobAccess = await withTenantRead(database.pool, ORG, (db) => authorizeCommandInTransaction(db, "emissions.target.upsert", subjectIds as never, context()));
    assert.doesNotThrow(() => requireConditionalCapability(context(), "baseline.rebaseline", jobAccess));
  });

  it("(a) #2, #4: portal administration (the non-command paths) is held on the colleague's client and job", async () => {
    await withTenantRead(database.pool, ORG, async (db) => {
      assert.equal((await assertCapabilityOnClient(db, holder(), "portal.admin", { clientId: CLIENT })).ownedByActor, false);
      assert.equal((await assertCapabilityOnClient(db, holder(), "portal.admin", { jobId: JOB })).clientId, CLIENT);
      assert.equal((await assertCapabilityOnClient(db, holder(), "category.visibility", { clientId: CLIENT })).clientId, CLIENT);
    });
  });

  it("(a) #6: reads the colleague's client history — and the organisation-wide feed stays their own clients'", async () => {
    await withTenantRead(database.pool, ORG, async (db) => {
      const history = await clientHistoryFor(db, holder(), CLIENT);
      assert.ok(history?.some((entry) => JSON.stringify(entry).includes("ae-colleague")), "the colleague's client history opens");
      const feed = (await auditEventsFor(db, holder())).map((event) => event.id);
      assert.ok(feed.includes("ae-own"), "the feed shows their own client's event");
      assert.ok(!feed.includes("ae-colleague"), "(c) the organisation-wide feed does not show a colleague's client");
    });
  });

  it("(a) #29: sees everyone's time on the colleague's job", async () => {
    const summary = await withTenantRead(database.pool, ORG, (db) => readJobTimeSummary(db, holder(), JOB));
    assert.equal(summary.othersVisible, true);
  });

  it("(b) #18: batch attest accepts the consultant as the attesting person", async () => {
    const person = await personContext(database.pool, { organisationId: ORG, actorId: ACTOR, reason: "CRM access matrix v17 check", commit: false });
    assert.equal(person.grant.role, "consultant");
  });

  it("independent approval is untouched: off, the consultant may self-release; on, they may not", () => {
    assert.equal(maySelfApprove(grant.capabilities, false), true);
    assert.equal(maySelfApprove(grant.capabilities, true), false);
  });

  for (const [row, key] of RESTRICTED_ROWS) {
    it(`(c) #${row}: ${key} is refused`, async () => {
      await assert.rejects(() => authorize(key), (error: unknown) => error instanceof AuthorizationError && error.permission === commandDefinitions[key].permission);
    });
  }

  it("(c): every command under a withheld capability is refused", async () => {
    let refused = 0;
    for (const capability of CONSULTANT_WITHHELD) {
      for (const key of commandsUnder(capability)) {
        await assert.rejects(() => authorize(key), (error: unknown) => error instanceof AuthorizationError && error.permission === capability, key);
        refused += 1;
      }
    }
    assert.ok(refused > 10, `${refused} commands refused`);
  });

  it("(c) #16: the book runner is an operator run — no app route reaches it", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { if (!["node_modules", ".next"].includes(entry.name)) walk(path); }
        else if (/\.(ts|tsx)$/.test(entry.name) && /runV7BookJobInTransaction|v7-reingest-book|batchAttestReingestRuns/.test(readFileSync(path, "utf8"))) offenders.push(path);
      }
    };
    walk(resolve(here, "../../../apps/console/app"));
    assert.deepEqual(offenders, []);
  });
});
