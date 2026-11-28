import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, encodeImportIdentity, type CommandContext, type SpendImportIdentity, type SpendImportRow, type StaffRole } from "@nzi/contracts";
import {
  archiveClientFactor, commitSpendImport, createClientFactor, createEmissionSource, listClientFactors, previewSpendImport, setClientFactorYearValues,
  signSpendImportIdentity, syncEmissionSourceToScope, updateClientFactor, withTenantRead,
} from "../src/index";
import { withTenantWrite } from "../src/postgres";
import { recalculateScopeRowInTransaction } from "../src/postgresCommands";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * Client custom factors made fully manageable (BRIEF-client-custom-factors, PR B; GAPS G1, G2, G3, G6), against a real database
 * and through the commands as `nzi_console_app`:
 *   - G2: a factor's values by year are set as a whole, at a new version; a row already priced keeps its figure until re-priced,
 *     and a two-year job re-priced afterwards takes the new set month by month;
 *   - G1: a value edit on a factor priced by year is refused, in plain words; a label edit is not;
 *   - G3: an organisation-level factor (no client) is listed, made, edited, priced by year and archived by a CRM under
 *     `clientfactor.manage`; a user without it is refused, and another organisation cannot reach it;
 *   - G6: a factor is made on the client page (the client's) and on an LCA job (the job's client's); not on a training job;
 *   - moved in from PR A: a spend-import line and a template-import trip on an organisation-level factor file and price;
 *   - G7: a folded factor is not restored, said plainly.
 */
const ORG = "client-factors-manage";
const OTHER = "client-factors-elsewhere";
const CLIENT = "cfm-client";
const SECRET = "client-factors-manage-secret-at-least-thirty-two-bytes";

describe("Client custom factors, fully manageable — against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const as = (role: StaffRole, actor = `staff-${role}`, organisationId = ORG): CommandContext => {
    keys += 1;
    return { organisationId, actorId: actor, principal: "staff", idempotencyKey: `cfm-${keys}`, correlationId: `cfm-c-${keys}`, grant: commandGrantForRole(role, organisationId, actor) };
  };
  const factor = async (id: string) => (await db.query(
    `SELECT client_id, job_id, version, kgco2e_per_unit::float8 AS kg, vintage_year, report_label, archived FROM nzi_console.client_factors WHERE client_factor_id = $1`, [id])).rows[0];
  const codes = async (promise: Promise<unknown>) => {
    try { await promise; return []; } catch (error: any) { return (error.issues ?? [{ code: error.name }]).map((issue: any) => issue.code); }
  };
  const fields = { scope: "3.1", reportLabel: "Supplier EPD", description: "", unit: "kg", kgco2ePerUnit: 2, geography: "GB", vintageYear: 2025, source: "Supplier",
    reusable: true, evidenceFileName: null, evidenceStorageProvider: null, evidenceUrl: null, evidenceExternalItemId: null, evidenceHash: null } as const;
  const edit = (id: string, version: number, over: Partial<{ reportLabel: string; kgco2ePerUnit: number; vintageYear: number }> = {}) => ({ clientFactorId: id, expectedVersion: version,
    reportLabel: over.reportLabel ?? "Supplier EPD", description: "", unit: "kg", kgco2ePerUnit: over.kgco2ePerUnit ?? 2, geography: "GB", vintageYear: over.vintageYear ?? 2025, source: "Supplier",
    evidenceFileName: null, evidenceStorageProvider: null, evidenceUrl: null, evidenceExternalItemId: null, evidenceHash: null });
  async function job(jobId: string, family: string, sequence: number, from = "2024-07-01", to = "2025-06-30") {
    await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
      VALUES ($1,$2,$3,$4,$5,'Job','open','Data entry',$6,$7,$8)`, [ORG, jobId, CLIENT, sequence, family, Number(to.slice(0, 4)), from, to]);
    if (family === "crp") await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,$3,$4,'GB')`, [ORG, jobId, from, to]);
  }
  const price = async (jobId: string, rowId: string) => {
    const version = (await db.query(`SELECT version FROM nzi_console.job_scope_rows WHERE scope_row_id = $1`, [rowId])).rows[0]!.version as number;
    await withTenantWrite(database.pool, ORG, (client) => recalculateScopeRowInTransaction(client, { jobId, rowId, expectedVersion: version }, as("admin")));
    return (await db.query(`SELECT calculated_tco2e::float8 AS tco2e FROM nzi_console.job_scope_rows WHERE scope_row_id = $1`, [rowId])).rows[0]!.tco2e as number;
  };
  const tco2e = async (rowId: string) => (await db.query(`SELECT calculated_tco2e::float8 AS tco2e FROM nzi_console.job_scope_rows WHERE scope_row_id = $1`, [rowId])).rows[0]!.tco2e as number;

  before(async () => {
    database = (await createDisposableDatabase("clientfactorsmanage"))!;
    db = await database.admin();
    for (const org of [ORG, OTHER]) {
      await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [org]);
      await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
    }
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Manage Co','active')`, [ORG, CLIENT]);
    for (const role of ["admin", "consultant", "reviewer"]) await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,$3,'active')`, [ORG, `staff-${role}`, role]);
    await db.query(`INSERT INTO nzi_console.purchased_goods_categories (organisation_id,category_id,client_id,name,created_by) VALUES ($1,'pgs-general',$2,'General','test')`, [ORG, CLIENT]);
    await job("j-span", "crp", 1);
    await job("j-lca", "lca", 2);
    await job("j-training", "training", 3);
    await job("j-spend", "crp", 4, "2025-01-01", "2025-12-31");
  });
  after(async () => { await db?.end(); await database?.end(); });

  describe("G2 + G1: values by year", () => {
    let factorId = "";
    let rowId = "";
    const months = ["2024-07", "2024-08", "2024-09", "2024-10", "2024-11", "2024-12", "2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06"].map((month) => ({ month, quantity: 100 }));

    before(async () => {
      factorId = (await createClientFactor(database.pool, { ...fields, clientId: CLIENT, reportLabel: "Site gas", unit: "kWh", kgco2ePerUnit: 0.3, scope: "1" }, as("consultant"))).data.clientFactorId;
      rowId = randomUUID();
      await db.query(`INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,quantity,unit,
          factor_source,client_factor_id,factor_id,is_custom_entry,monthly_activity_json,review_status,enabled,origin)
        VALUES ($1,$2,'j-span','1','Gas','Gas','n','n',1200,'kWh','client',$3,$3,true,$4::jsonb,'pending',true,'live')`, [ORG, rowId, factorId, JSON.stringify(months)]);
      assert.ok(Math.abs(await price("j-span", rowId) - 0.36) < 1e-9, "no year values: 1,200 kWh at the headline 0.3");
    });

    it("sets the whole set at a new version; the headline is the latest year's; a priced row keeps its figure until re-priced", async () => {
      const set = await setClientFactorYearValues(database.pool, { clientFactorId: factorId, expectedVersion: 1, values: [{ year: 2025, kgco2ePerUnit: 0.4 }, { year: 2024, kgco2ePerUnit: 0.2 }] }, as("consultant"));
      assert.deepEqual([set.data.version, set.data.years], [2, [2024, 2025]]);
      const after = await factor(factorId);
      assert.deepEqual([after.version, after.kg, after.vintage_year], [2, 0.4, 2025]);
      assert.equal(await tco2e(rowId), 0.36, "not re-priced: the row keeps its figure");
      assert.ok(Math.abs(await price("j-span", rowId) - (600 * 0.2 + 600 * 0.4) / 1000) < 1e-9, "re-priced: 6 months @ 2024, 6 @ 2025");
      const listed = (await withTenantRead(database.pool, ORG, (client) => listClientFactors(client, ORG, CLIENT))).find((entry) => entry.clientFactorId === factorId)!;
      assert.deepEqual(listed.yearValues, [{ year: 2024, kgco2ePerUnit: 0.2 }, { year: 2025, kgco2ePerUnit: 0.4 }]);
      const audit = (await db.query(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'client_factor_year_values_set'`, [ORG])).rows[0]!.n;
      assert.equal(audit, 1);
    });

    it("a second set replaces the first; a stale version is a conflict; an archived factor is refused", async () => {
      await setClientFactorYearValues(database.pool, { clientFactorId: factorId, expectedVersion: 2, values: [{ year: 2024, kgco2ePerUnit: 0.25 }] }, as("admin"));
      const listed = (await withTenantRead(database.pool, ORG, (client) => listClientFactors(client, ORG, CLIENT))).find((entry) => entry.clientFactorId === factorId)!;
      assert.deepEqual(listed.yearValues, [{ year: 2024, kgco2ePerUnit: 0.25 }], "the whole set, not merged with the last");
      assert.ok(Math.abs(await price("j-span", rowId) - 1.2 * 0.25) < 1e-9, "every month at 2024's, the closest earlier for 2025");
      assert.deepEqual(await codes(setClientFactorYearValues(database.pool, { clientFactorId: factorId, expectedVersion: 2, values: [{ year: 2024, kgco2ePerUnit: 1 }] }, as("admin"))), ["VersionConflictError"]);
    });

    it("G1: a value edit on a factor priced by year is refused, in plain words; a label edit is not", async () => {
      const current = await factor(factorId);
      await assert.rejects(updateClientFactor(database.pool, { ...edit(factorId, current.version, { kgco2ePerUnit: 9 }), unit: "kWh" }, as("consultant")),
        (error: any) => error.issues?.[0]?.code === "PRICED_BY_YEAR" && error.issues[0].message === "This factor is priced by year. Change its values in Years.");
      const renamed = await updateClientFactor(database.pool, { ...edit(factorId, current.version, { reportLabel: "Site gas (metered)", kgco2ePerUnit: current.kg, vintageYear: current.vintage_year }), unit: "kWh" }, as("consultant"));
      assert.deepEqual([renamed.data.versionBumped, (await factor(factorId)).report_label], [false, "Site gas (metered)"]);
    });
  });

  describe("G3: organisation-level factors", () => {
    let orgFactorId = "";

    it("a CRM makes one: no client, no job; it is listed with the organisation's, not a client's", async () => {
      const made = await createClientFactor(database.pool, { ...fields, organisationLevel: true, reportLabel: "Courier (all clients)", unit: "km", kgco2ePerUnit: 0.1, scope: "3.6" }, as("consultant"));
      orgFactorId = made.data.clientFactorId;
      assert.deepEqual([made.data.clientId, made.data.organisationLevel], [null, true]);
      const row = await factor(orgFactorId);
      assert.deepEqual([row.client_id, row.job_id], [null, null]);
      const organisation = await withTenantRead(database.pool, ORG, (client) => listClientFactors(client, ORG, null));
      assert.deepEqual(organisation.map((entry) => entry.clientFactorId), [orgFactorId]);
      const client = await withTenantRead(database.pool, ORG, (tx) => listClientFactors(tx, ORG, CLIENT));
      assert.ok(!client.some((entry) => entry.clientFactorId === orgFactorId));
    });

    it("a CRM edits it, sets its years and archives it; a user without clientfactor.manage is refused each", async () => {
      const refused = (error: any) => /Authori[sz]ation/.test(error.name);
      await assert.rejects(createClientFactor(database.pool, { ...fields, organisationLevel: true }, as("reviewer")), refused);
      await assert.rejects(updateClientFactor(database.pool, { ...edit(orgFactorId, 1, { reportLabel: "Courier" }), unit: "km", kgco2ePerUnit: 0.1 }, as("reviewer")), refused);
      await assert.rejects(archiveClientFactor(database.pool, { clientFactorId: orgFactorId, archived: true }, as("reviewer")), refused);
      await assert.rejects(setClientFactorYearValues(database.pool, { clientFactorId: orgFactorId, expectedVersion: 1, values: [{ year: 2025, kgco2ePerUnit: 1 }] }, as("reviewer")), refused);

      const edited = await updateClientFactor(database.pool, { ...edit(orgFactorId, 1, { reportLabel: "Courier", kgco2ePerUnit: 0.12 }), unit: "km" }, as("consultant"));
      assert.deepEqual([edited.data.version, (await factor(orgFactorId)).kg], [2, 0.12]);
      await setClientFactorYearValues(database.pool, { clientFactorId: orgFactorId, expectedVersion: 2, values: [{ year: 2025, kgco2ePerUnit: 0.11 }] }, as("consultant"));
      await archiveClientFactor(database.pool, { clientFactorId: orgFactorId, archived: true }, as("consultant"));
      assert.equal((await factor(orgFactorId)).archived, true);
      await archiveClientFactor(database.pool, { clientFactorId: orgFactorId, archived: false }, as("admin"));
    });

    it("another organisation cannot reach it", async () => {
      await assert.rejects(archiveClientFactor(database.pool, { clientFactorId: orgFactorId, archived: true }, as("admin", "staff-other", OTHER)),
        (error: any) => /Authori[sz]ation/.test(error.name));
    });

    it("moved in from PR A: a spend-import line on it files and prices; so does a template-import trip", async () => {
      const spend = (await createClientFactor(database.pool, { ...fields, organisationLevel: true, reportLabel: "Courier spend", unit: "GBP", kgco2ePerUnit: 0.3, scope: "3.1" }, as("admin"))).data.clientFactorId;
      const identity: SpendImportIdentity = { jobId: "j-spend", jobNumber: "J000004", clientName: "Manage Co", jobName: "Job", reportingYear: 2025,
        reportingFrom: "2025-01-01", reportingTo: "2025-12-31", domain: "spend", templateVersion: 1 };
      const lines: SpendImportRow[] = [{ rowNumber: 1, description: "Courier account", netValue: 1000, vatPercent: 20, glCode: null, invoiceDate: "2025-03-01",
        purchasedGoodsCategoryId: "pgs-general", factorSource: "client", factorId: null, datasetId: null, clientFactorId: spend, monthly: [] }];
      const preview = await previewSpendImport(database.pool, ORG, identity, lines, 1);
      assert.deepEqual(preview.kind === "preview" ? preview.reviews[0]!.issues.map((issue) => issue.code) : ["not a preview"], []);
      await commitSpendImport(database.pool, { jobId: "j-spend", token: encodeImportIdentity(identity, signSpendImportIdentity(identity, SECRET)), rows: lines }, as("admin"), SECRET);
      const source = (await db.query(`SELECT source_id, factor_id FROM nzi_console.job_emission_sources WHERE job_id = 'j-spend' AND client_factor_id = $1`, [spend])).rows[0]!;
      assert.equal(source.factor_id, spend, "a client-factor line carries its factor's id, as the drawer writes it");
      const synced = await syncEmissionSourceToScope(database.pool, { jobId: "j-spend", sourceId: source.source_id }, as("admin"));
      assert.ok(Math.abs(await price("j-spend", synced.data.rowId) - 0.3) < 1e-9, "£1,000 net at 0.3 kg/£");

      const trip = await createEmissionSource(database.pool, { jobId: "j-spend", groupId: null, scope: "3.6", sourceType: "travel", sourceSubtype: null, siteId: null,
        sourceName: "Courier run", assetIdentifier: null, purchasedGoodsCategoryId: null, datasetId: null, factorId: orgFactorId, factorSource: "client", clientFactorId: orgFactorId,
        quantity: 1000, unit: "km", applyPct: 100, dataSource: "Business travel template import", dataConfidence: "M", monthlyActivity: [],
        detail: { kind: "travel", travelMode: "rail", airHaul: null, cabinClass: null, nights: null, tripDate: "2025-05-01", origin: null, destination: null, carrier: null, distanceUnit: "km", passengers: 1 },
        notes: null, importBatchId: randomUUID() }, as("admin"));
      const tripRow = (await syncEmissionSourceToScope(database.pool, { jobId: "j-spend", sourceId: trip.data.sourceId }, as("admin"))).data.rowId;
      assert.ok(Math.abs(await price("j-spend", tripRow) - 0.11) < 1e-9, "the organisation factor's 2025 value, 0.11, for a 2025 job");
    });
  });

  describe("G6: made anywhere", () => {
    it("on the client page: the client's, reusable; on an LCA job: the job's client's, pinned unless reusable", async () => {
      const onClient = (await createClientFactor(database.pool, { ...fields, clientId: CLIENT }, as("consultant"))).data.clientFactorId;
      assert.deepEqual(Object.values(await factor(onClient)).slice(0, 2), [CLIENT, null]);
      const onLca = (await createClientFactor(database.pool, { ...fields, jobId: "j-lca", reusable: false }, as("consultant"))).data.clientFactorId;
      assert.deepEqual(Object.values(await factor(onLca)).slice(0, 2), [CLIENT, "j-lca"]);
      assert.deepEqual(await codes(createClientFactor(database.pool, { ...fields, jobId: "j-training" }, as("consultant"))), ["WRONG_FAMILY"]);
      assert.deepEqual(await codes(createClientFactor(database.pool, { ...fields, clientId: "no-such-client" }, as("admin"))), ["AuthorizationError"], "a client not in the organisation is refused before the handler");
    });
  });

  describe("G7: a folded factor", () => {
    it("is not restored, and says why", async () => {
      const target = (await createClientFactor(database.pool, { ...fields, clientId: CLIENT, reportLabel: "Loaded" }, as("admin"))).data.clientFactorId;
      await db.query(`INSERT INTO nzi_console.client_factors (organisation_id,client_factor_id,client_id,scope,report_label,unit,kgco2e_per_unit,vintage_year,created_by,archived,folded_into_client_factor_id)
        VALUES ($1,'cf-folded',$2,'3.1','Carried','kg',2,2025,'test',true,$3)`, [ORG, CLIENT, target]);
      assert.deepEqual(await codes(archiveClientFactor(database.pool, { clientFactorId: "cf-folded", archived: false }, as("admin"))), ["FOLDED"]);
    });
  });
});
