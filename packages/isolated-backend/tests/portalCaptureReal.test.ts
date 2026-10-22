import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type CommandContext, type CommandInputMap, type PortalCommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  AuthorizationError, CommandValidationError, createPortalScopeRow, createScopeRow, deactivatePortalScopeRow, getPortalDataView, getPortalRowHistory,
  listInputSpecForClient, listJobFactorOptions, setClientCategoryVisibility, setClientPortalProfile, setClientPortalScopeVisibility, updatePortalScopeRow, updateScopeRow,
  type PortalPrincipal,
} from "../src/index";

/**
 * Portal data-entry phase 2, against a real database (RULING-portal-dataentry-02; BUILD-portal-dataentry-phase2 §1, §2, §6):
 * the client enters on the job's own scope rows, through the CRM's own handlers, as a portal principal.
 *
 *  1. **It lands as the accept-write left one, on save**: pending, `capturedAs: "client-portal"` with the portal user, no staff
 *     `capturedBy`, no figure, no review — and the client has no command that could change any of that (NZC-022).
 *  2. **It is the CRM's write**: the same input resolves, files and unit-checks to the same row as a member of staff's.
 *  3. **It is gated at the write boundary**: the access grant and its window (runner), the scope ∧ category profile, the
 *     staff-only fields, the client's own pending rows only, Deactivate only where the profile offers it.
 *  4. **The seam**: audit as `portal`, its own outbox topics, idempotent replay.
 *  5. **The reads**: narrowed by the profile, no staff identity, and a row's History for the client.
 */
const ORG = "demo-nzi-console"; // the synthetic factor seed's organisation
const CLIENT = "client-pc", OTHER_CLIENT = "client-other";
const JOB = "job-pc", UNGRANTED_JOB = "job-pc-2", OTHER_JOB = "job-other";
const USER = "portal-pc", STAFF = "staff-pc";
const DATASET = "synthetic-gb-2026";
const here = dirname(fileURLToPath(import.meta.url));
const portalPrincipal = { principal: "portal", organisationId: ORG, userId: USER, clientId: CLIENT, sessionId: "p", issuedAt: 1, expiresAt: 2, displayName: "P", email: "p@example.invalid" } as unknown as PortalPrincipal;

describe("the client enters on the shared scope rows (portal data-entry phase 2)", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const portal = (over: Partial<PortalCommandContext> = {}): PortalCommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: USER, principal: "portal", portal: { portalUserId: USER, clientId: CLIENT }, idempotencyKey: `pc-${keys}`, correlationId: `corr-pc-${keys}`, ...over };
  };
  const staff = (reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: STAFF, principal: "staff", idempotencyKey: `st-${keys}`, correlationId: `corr-st-${keys}`, grant: commandGrantForRole("admin", ORG, STAFF), ...(reason ? { reason } : {}) };
  };
  const gas = (over: Partial<CommandInputMap["portal.scope.row.create"]> = {}): CommandInputMap["portal.scope.row.create"] => ({
    jobId: JOB, scope: "1", categoryCode: "1.natural-gas", sourceLabel: "Boiler gas", siteId: null, quantity: 1000, unit: "kWh",
    datasetId: DATASET, factorId: "gas-demo", factorVersion: null, factorLabel: "Natural gas", notes: null, monthlyActivity: [], ...over,
  });
  const row = async (rowId: string) => (await db.query(`SELECT * FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId])).rows[0];
  const codes = (error: unknown) => error instanceof CommandValidationError ? error.issues.map((issue) => issue.code) : [];

  before(async () => {
    database = (await createDisposableDatabase("portalcapture"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Co','active'),($1,$3,'Other','active')`, [ORG, CLIENT, OTHER_CLIENT]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name) VALUES ($1,$2,'admin','active','Sam Staff')`, [ORG, STAFF]);
    for (const [job, client] of [[JOB, CLIENT], [UNGRANTED_JOB, CLIENT], [OTHER_JOB, OTHER_CLIENT]] as const) {
      await db.query(
        `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
         VALUES ($1,$2,$3,(SELECT coalesce(max(sequence),0)+1 FROM nzi_console.jobs),'crp','CRP','open','Data entry',2026,'2026-01-01','2026-12-31')`, [ORG, job, client]);
      await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2026-01-01','2026-12-31','GB')`, [ORG, job]);
    }
    await db.query(readFileSync(resolve(here, "../seeds/0003_synthetic_factors.sql"), "utf8"));
    for (const job of [JOB, UNGRANTED_JOB, OTHER_JOB]) {
      await db.query(`INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by) VALUES ($1,$2,$3,'automatic','Fixture',$4) ON CONFLICT DO NOTHING`, [ORG, job, DATASET, STAFF]);
    }
    await db.query(`INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,status) VALUES ($1,$2,$3,'active')`, [ORG, USER, CLIENT]);
    // A grant on JOB with its window open; a grant on UNGRANTED_JOB that is revoked.
    await db.query(
      `INSERT INTO nzi_console.portal_access_grants (organisation_id,grant_id,client_id,portal_user_id,job_id,data_entry_starts_at,data_entry_expires_at,revoked_at)
       VALUES ($1,'grant-pc',$2,$3,$4,now() - interval '1 day', now() + interval '30 days',NULL),
              ($1,'grant-pc-revoked',$2,$3,$5,now() - interval '1 day', now() + interval '30 days',now())`, [ORG, CLIENT, USER, JOB, UNGRANTED_JOB]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  describe("a client's entry lands as the accept-write left one — on save, pending, never reviewed", () => {
    let rowId = "";
    it("is pending, client-provenanced, with no staff author, no figure and no review", async () => {
      const outcome = await createPortalScopeRow(database.pool, gas(), portal());
      rowId = outcome.data.rowId;
      const stored = await row(rowId);
      assert.equal(stored.review_status, "pending");
      assert.equal(stored.reviewed_by, null);
      assert.equal(stored.reviewed_at, null);
      assert.equal(stored.calculated_tco2e, null);
      assert.equal(stored.provenance_json.capturedAs, "client-portal");
      assert.equal(stored.provenance_json.portalUserId, USER);
      assert.equal(stored.provenance_json.capturedBy, undefined, "no staff author: the independent-review check can never mistake the client for staff");
      assert.ok(stored.lineage_json.some((step: { reviewState?: string }) => step.reviewState === "pending-client-entry"));
    });

    it("is audited as the portal user, emits portal.scope.row.created, and replays idempotently", async () => {
      const audit = (await db.query(`SELECT principal_type, actor_id, action FROM nzi_console.audit_events WHERE entity_id=$1`, [rowId])).rows;
      assert.deepEqual(audit, [{ principal_type: "portal", actor_id: USER, action: "portal_scope_row_created" }]);
      const topics = (await db.query(`SELECT o.topic FROM nzi_console.transactional_outbox o JOIN nzi_console.audit_events a ON a.correlation_id=o.correlation_id WHERE a.entity_id=$1`, [rowId])).rows;
      assert.deepEqual(topics, [{ topic: "portal.scope.row.created" }]);
      const context = portal();
      const first = await createPortalScopeRow(database.pool, gas({ sourceLabel: "Replay" }), context);
      const replay = await createPortalScopeRow(database.pool, gas({ sourceLabel: "Replay" }), context);
      assert.equal(replay.data.rowId, first.data.rowId);
      assert.equal(replay.replayed, true);
    });

    it("resolves, files and unit-checks exactly as the CRM write does for the same input", async () => {
      const crm = await createScopeRow(database.pool, { ...gas(), sourceLabel: "Boiler gas (staff)", qualityTier: null }, staff());
      const [client, mine] = [await row(rowId), await row(crm.data.rowId)];
      for (const column of ["factor_id", "dataset_id", "factor_version", "factor_label", "filed_suffix_code", "unit", "quantity", "category_code", "level_1", "level_2", "scope"]) {
        assert.deepEqual(client[column], mine[column], column);
      }
      // A unit the factor cannot take is refused for the client as it is for staff (NZC-146).
      await assert.rejects(createPortalScopeRow(database.pool, gas({ unit: "litres" }), portal()), (error) => codes(error).some((code) => /UNIT/.test(code)));
      await assert.rejects(createScopeRow(database.pool, { ...gas({ unit: "litres" }), qualityTier: null }, staff()), (error) => codes(error).some((code) => /UNIT/.test(code)));
    });

    it("gives the client no way to review, approve or write as staff: a portal principal is refused every staff command", async () => {
      await assert.rejects(updateScopeRow(database.pool, { ...gas(), rowId, expectedVersion: 1, enabled: true, qualityTier: null }, portal() as unknown as CommandContext), AuthorizationError);
      await assert.rejects(createScopeRow(database.pool, { ...gas(), qualityTier: null }, portal() as unknown as CommandContext), AuthorizationError);
      // And a member of staff cannot run the portal's command.
      await assert.rejects(createPortalScopeRow(database.pool, gas(), staff()), AuthorizationError);
      // A forged context — a portal principal carrying a matching staff grant — is refused by the principal, not let through by
      // the grant (mutation-found: the grant check alone would pass it).
      const forged = { ...portal(), grant: commandGrantForRole("admin", ORG, USER) } as unknown as CommandContext;
      await assert.rejects(createScopeRow(database.pool, { ...gas(), qualityTier: null }, forged), /cannot run this command/);
    });

    it("refuses every staff-only field, whatever the request carries", async () => {
      for (const extra of [{ overrideTco2e: 5, overrideReason: "x" }, { qualityTier: "measured" }, { factorSource: "client", clientFactorId: "cf" }, { applyPct: 50 }, { usageTypeId: "car" }]) {
        await assert.rejects(createPortalScopeRow(database.pool, { ...gas(), ...extra } as never, portal()), (error) => codes(error).includes("STAFF_ONLY_FIELD"), JSON.stringify(extra));
      }
    });
  });

  describe("gated at the write boundary", () => {
    it("by the access grant and its open window — no grant, a revoked one, another client's job, a closed window", async () => {
      await assert.rejects(createPortalScopeRow(database.pool, gas({ jobId: UNGRANTED_JOB }), portal()), AuthorizationError);
      await assert.rejects(createPortalScopeRow(database.pool, gas({ jobId: OTHER_JOB }), portal()), AuthorizationError);
      await db.query(`UPDATE nzi_console.portal_access_grants SET data_entry_expires_at = now() - interval '1 minute', data_entry_starts_at = now() - interval '2 days' WHERE grant_id='grant-pc'`);
      await assert.rejects(createPortalScopeRow(database.pool, gas(), portal()), /not open just now/);
      await db.query(`UPDATE nzi_console.portal_access_grants SET data_entry_expires_at = now() + interval '30 days' WHERE grant_id='grant-pc'`);
    });

    it("by scope ∧ category: a hidden scope or category refuses the write and leaves the read; withdrawn, both return", async () => {
      await setClientPortalScopeVisibility(database.pool, { clientId: CLIENT, scope: "1", visible: false }, staff());
      await assert.rejects(createPortalScopeRow(database.pool, gas(), portal()), (error) => codes(error).includes("CATEGORY_NOT_AVAILABLE"));
      let view = await getPortalDataView(database.pool, portalPrincipal, JOB);
      assert.ok(!view.rows.some((entry) => entry.scope === "1"), "a hidden scope's rows are not read");
      assert.ok(!view.categories.categories.some((category) => category.scope === "1"));
      assert.ok(!(await listInputSpecForClient(db, CLIENT)).some((category) => category.scope === "1"), "the live spec follows the scope switch (§6)");
      await setClientPortalScopeVisibility(database.pool, { clientId: CLIENT, scope: "1", visible: null }, staff());
      await setClientCategoryVisibility(database.pool, { clientId: CLIENT, categoryCode: "1.natural-gas", visible: false }, staff());
      await assert.rejects(createPortalScopeRow(database.pool, gas(), portal()), (error) => codes(error).includes("CATEGORY_NOT_AVAILABLE"));
      view = await getPortalDataView(database.pool, portalPrincipal, JOB);
      assert.ok(!view.rows.some((entry) => entry.categoryCode === "1.natural-gas"));
      await setClientCategoryVisibility(database.pool, { clientId: CLIENT, categoryCode: "1.natural-gas", visible: null }, staff());
      assert.ok((await getPortalDataView(database.pool, portalPrincipal, JOB)).rows.some((entry) => entry.categoryCode === "1.natural-gas"));
    });

    it("a client changes only a client's entry that is still pending — never staff's, never a reviewed one", async () => {
      const mine = (await createPortalScopeRow(database.pool, gas({ sourceLabel: "Mine" }), portal())).data.rowId;
      const updated = await updatePortalScopeRow(database.pool, { ...gas({ sourceLabel: "Mine", quantity: 1200 }), rowId: mine, expectedVersion: 1 }, portal());
      assert.equal(updated.data.version, 2);
      const stored = await row(mine);
      assert.equal(Number(stored.quantity), 1200);
      assert.equal(stored.review_status, "pending");
      assert.equal(stored.provenance_json.capturedAs, "client-portal");
      assert.deepEqual((await db.query(`SELECT o.topic FROM nzi_console.transactional_outbox o WHERE o.correlation_id=$1`, [`corr-pc-${keys}`])).rows, [{ topic: "portal.scope.row.updated" }]);

      const theirs = (await createScopeRow(database.pool, { ...gas({ sourceLabel: "Staff's" }), qualityTier: null }, staff())).data.rowId;
      await assert.rejects(updatePortalScopeRow(database.pool, { ...gas(), rowId: theirs, expectedVersion: 1 }, portal()), (error) => codes(error).includes("CLIENT_ROW_NOT_EDITABLE"));
      // Reviewed by staff (the review evidence the database requires): no longer the client's to change.
      await db.query(`UPDATE nzi_console.job_scope_rows SET calculated_tco2e=0.18, review_status='approved', reviewed_row_version=version, reviewed_by=$2, reviewed_at=now() WHERE scope_row_id=$1`, [mine, STAFF]);
      await assert.rejects(updatePortalScopeRow(database.pool, { ...gas(), rowId: mine, expectedVersion: 2 }, portal()), (error) => codes(error).includes("CLIENT_ROW_NOT_EDITABLE"));
    });

    it("Deactivate only where the profile offers it, and only on the client's own pending entry", async () => {
      const mine = (await createPortalScopeRow(database.pool, gas({ sourceLabel: "To go" }), portal())).data.rowId;
      await assert.rejects(deactivatePortalScopeRow(database.pool, { jobId: JOB, rowId: mine, expectedVersion: 1 }, portal({ reason: "duplicate" })), (error) => codes(error).includes("ACTION_NOT_OFFERED"));
      await setClientPortalProfile(database.pool, { clientId: CLIENT, profileKey: "deactivate", value: "enabled" }, staff());
      const done = await deactivatePortalScopeRow(database.pool, { jobId: JOB, rowId: mine, expectedVersion: 1 }, portal({ reason: "duplicate" }));
      assert.equal(done.data.enabled, false);
      assert.equal((await row(mine)).enabled, false);
      const theirs = (await createScopeRow(database.pool, { ...gas({ sourceLabel: "Staff's 2" }), qualityTier: null }, staff())).data.rowId;
      await assert.rejects(deactivatePortalScopeRow(database.pool, { jobId: JOB, rowId: theirs, expectedVersion: 1 }, portal({ reason: "x" })), (error) => codes(error).includes("CLIENT_ROW_NOT_EDITABLE"));
      await assert.rejects(deactivatePortalScopeRow(database.pool, { jobId: JOB, rowId: mine, expectedVersion: 2 }, portal()), CommandValidationError, "a reason, as staff give one");
      await setClientPortalProfile(database.pool, { clientId: CLIENT, profileKey: "deactivate", value: null }, staff());
    });
  });

  describe("the reads", () => {
    it("the Data view: the profile, the window, the CRM's own server totals for shown categories, rows without staff identity, dataset factors only", async () => {
      const view = await getPortalDataView(database.pool, portalPrincipal, JOB);
      assert.equal(view.access?.state, "open");
      assert.deepEqual(view.profile.areas, ["milestones"], "the default profile");
      const gasCategory = view.categories.categories.find((category) => category.code === "1.natural-gas")!;
      assert.ok(gasCategory.entryCount >= 1, "server-computed entry count");
      assert.equal(typeof gasCategory.completeness, "number");
      const serialised = JSON.stringify(view.rows);
      assert.doesNotMatch(serialised, new RegExp(STAFF), "no member of staff's id reaches the client");
      assert.ok(!view.rows.some((entry) => "reviewedBy" in entry), "no reviewer");
      assert.ok(view.rows.filter((entry) => entry.editable).every((entry) => (entry.provenance as { capturedAs?: string }).capturedAs === "client-portal" && entry.reviewStatus === "pending"));
      // A client factor exists for this job, and the CRM's list offers it; the client's never does (settled 22 Oct).
      await db.query(`INSERT INTO nzi_console.client_factors (organisation_id,client_factor_id,client_id,job_id,scope,report_label,unit,kgco2e_per_unit,vintage_year,created_by)
        VALUES ($1,'cf-pc',$2,$3,'1','Client EPD gas','kWh',0.17,2026,$4) ON CONFLICT DO NOTHING`, [ORG, CLIENT, JOB, STAFF]);
      const crmFactors = await listJobFactorOptions(db, JOB);
      assert.ok(crmFactors.some((factor) => factor.factorSource === "client"), "precondition: the CRM offers the client factor");
      const withClientFactor = await getPortalDataView(database.pool, portalPrincipal, JOB);
      assert.ok(withClientFactor.factors.length > 0 && withClientFactor.factors.every((factor) => factor.factorSource !== "client"));
      await assert.rejects(getPortalDataView(database.pool, portalPrincipal, OTHER_JOB), AuthorizationError);
    });

    it("a row's History for the client: what happened and when, by you or your adviser — never a name", async () => {
      const mine = (await createPortalScopeRow(database.pool, gas({ sourceLabel: "Historied" }), portal())).data.rowId;
      await updatePortalScopeRow(database.pool, { ...gas({ sourceLabel: "Historied", quantity: 1500 }), rowId: mine, expectedVersion: 1 }, portal());
      const history = await getPortalRowHistory(database.pool, portalPrincipal, JOB, mine);
      assert.deepEqual(history.map((entry) => [entry.who, entry.action]), [["you", "portal_scope_row_updated"], ["you", "portal_scope_row_created"]]);
      const staffRow = (await createScopeRow(database.pool, { ...gas({ sourceLabel: "Staff history" }), qualityTier: null }, staff())).data.rowId;
      const theirs = await getPortalRowHistory(database.pool, portalPrincipal, JOB, staffRow);
      assert.deepEqual(theirs.map((entry) => entry.who), ["adviser"]);
      assert.doesNotMatch(JSON.stringify(theirs), new RegExp(STAFF));
    });
  });
});
