import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, confirmProposal, entryGaps, readEntryOrigin } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { createScopeRow, listInputSpec, listScopeRows, proposeFromRegistration } from "../src/index";

/**
 * A registration proposes an entry, and the plate does not come with it (NZC-113).
 *
 * Two properties, and the second is the one that needed a test rather than an argument:
 *
 * 1. A plate resolves, through the existing lookup and factor resolver, to a proposal carrying a
 *    factor from *this job's* datasets — and nothing commits until a person confirms.
 * 2. The registration reaches the row where it has always been stored (`asset_identifier`, NZC-103)
 *    and reaches the permanent audit record **nowhere** — because the assist record has no shape
 *    that could hold it.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-a";
const CLIENT = "client-a";
const JOB = "job-a";
const ACTOR = "consultant-a";
const PLATE = "AB12CDE";

const context = (key: string) => ({
  organisationId: ORG, actorId: ACTOR, principal: "staff" as const,
  idempotencyKey: key, correlationId: `corr-${key}`,
  grant: commandGrantForRole("admin", ORG, ACTOR),
});

/** No key, stub allowed — the isolated-staging shape, and the one that reaches no network. */
const STUB = { apiKey: null, allowStub: true };

describe("a registration proposes an entry (NZC-113)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let pool: pg.Pool;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("regproposal"))!;
    pool = database.pool;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Org')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,'admin','active')`,
      [ORG, ACTOR]);
    await db.query(
      `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Client','active')`,
      [ORG, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,$3,1,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31')`, [ORG, JOB, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
       VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [ORG, JOB]);
    await db.query(
      `INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
       VALUES ($1,'ds-1','Synthetic GB','2025.1','2025-01-01','2025-12-31','GB','active','Synthetic','OGL')`, [ORG]);
    // Enough of a catalogue that the resolver has to choose rather than take the only row.
    for (const [factorId, label] of [
      ["f-diesel-van", "Diesel — van (light goods)"],
      ["f-petrol-car", "Petrol — car"],
      ["f-electric-car", "Electric — car"],
    ] as const) {
      await db.query(
        `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
         VALUES ($1,'ds-1',$2,$3,'miles',0.3,ARRAY['1'])`, [ORG, factorId, label]);
    }
    await db.query(
      `INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by)
       VALUES ($1,$2,'ds-1','automatic','Fixture',$3)`, [ORG, JOB, ACTOR]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  const rowCount = async () => Number((await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM nzi_console.job_scope_rows WHERE job_id=$1`, [JOB])).rows[0]!.count);

  it("resolves a plate to a factor from this job's own datasets, and writes nothing", async () => {
    const before = await rowCount();
    const outcome = await proposeFromRegistration(db, { registration: PLATE, jobId: JOB, config: STUB });
    assert.equal(outcome.kind, "proposal");
    if (outcome.kind !== "proposal") return;
    assert.equal(outcome.proposal.categoryCode, "1.company-vehicles");
    assert.equal(outcome.proposal.scope, "1");
    assert.equal(outcome.proposal.datasetId, "ds-1");
    assert.ok(outcome.proposal.factorId, "a factor was resolved from the vehicle");
    assert.equal(await rowCount(), before, "looking a plate up is not writing");
  });

  it("carries no registration anywhere in the proposal", async () => {
    // Serialised and searched rather than field-checked: a plate reaching a field added later would
    // pass a test that only looked at the fields present when it was written.
    const outcome = await proposeFromRegistration(db, { registration: PLATE, jobId: JOB, config: STUB });
    const serialised = JSON.stringify(outcome).toUpperCase();
    assert.ok(!serialised.includes("AB12"), `the proposal must not carry the plate: ${serialised.slice(0, 300)}`);
    assert.ok(!serialised.includes(PLATE));
  });

  it("leaves the distance for the loop to ask about rather than inventing one", async () => {
    // A registration cannot say how far the vehicle went. Null means the spec finds it missing.
    const outcome = await proposeFromRegistration(db, { registration: PLATE, jobId: JOB, config: STUB });
    if (outcome.kind !== "proposal") return assert.fail("expected a proposal");
    assert.equal(outcome.proposal.quantity, null);
    const category = (await listInputSpec(db)).find((entry) => entry.categoryCode === outcome.proposal.categoryCode)!;
    assert.ok(entryGaps(category, "crm", "new", outcome.proposal.values).some((gap) => gap.fieldKey === "quantity"));
  });

  it("commits once a person supplies the distance and confirms", async () => {
    const outcome = await proposeFromRegistration(db, { registration: PLATE, jobId: JOB, config: STUB });
    if (outcome.kind !== "proposal") return assert.fail("expected a proposal");

    const confirmed = confirmProposal(outcome.proposal, { quantity: 8200 }, "console");
    assert.equal(confirmed.ok, true);
    if (!confirmed.ok) return;

    // The plate travels as the row's asset identifier, from the field the person typed it into —
    // the same way a manual vehicle entry carries it (NZC-103), and not through the proposal.
    const created = await createScopeRow(pool, {
      ...confirmed.entry, jobId: JOB, reportLabel: confirmed.entry.sourceLabel,
      assetIdentifier: PLATE, factorVersion: "2025.1", factorLabel: confirmed.entry.sourceLabel,
      qualityTier: "estimated" as const,
      capturedVia: confirmed.record.capturedVia, assistRecord: confirmed.record,
    }, context("reg-1"));

    const row = (await listScopeRows(db, JOB)).find((candidate) => candidate.id === created.data.rowId)!;
    assert.equal(row.quantity, 8200);
    assert.equal(row.assetIdentifier, PLATE, "the registration is on the row, where it is documented to be");
  });

  it("keeps the plate out of the permanent audit record", async () => {
    const { rows } = await db.query<{ after_json: Record<string, unknown> }>(
      `SELECT after_json FROM nzi_console.audit_events WHERE action='scope_row_created' ORDER BY occurred_at DESC LIMIT 1`);
    const serialised = JSON.stringify(rows[0]!.after_json).toUpperCase();
    assert.ok(serialised.includes("ASSIST"), "the assisted entry is audited");
    assert.ok(!serialised.includes("AB12"), `the audit record must not carry the plate: ${serialised.slice(0, 300)}`);
    // And the entry still says how it was captured.
    const provenance = await db.query<{ provenance_json: Record<string, unknown> }>(
      `SELECT provenance_json FROM nzi_console.job_scope_rows WHERE job_id=$1 ORDER BY created_at DESC LIMIT 1`, [JOB]);
    assert.equal(readEntryOrigin(provenance.rows[0]!.provenance_json).via, "ai-assisted");
  });

  it("abstains on an implausible registration, without repeating it back", async () => {
    const before = await rowCount();
    const outcome = await proposeFromRegistration(db, { registration: "X", jobId: JOB, config: STUB });
    assert.equal(outcome.kind, "abstained");
    if (outcome.kind !== "abstained") return;
    // An error string is exactly what gets logged, so it must not contain the input.
    assert.ok(!outcome.reason.includes("X"), `the refusal must not echo the input: ${outcome.reason}`);
    assert.equal(await rowCount(), before);
  });

  it("abstains when the job's datasets have no matching factor, rather than proposing another job's", async () => {
    const bare = "job-bare";
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,$3,2,'crp','Bare','open','Data entry',2025,'2025-01-01','2025-12-31')`, [ORG, bare, CLIENT]);
    // No dataset selection at all: the vehicle resolves, and there is nothing to propose.
    const outcome = await proposeFromRegistration(db, { registration: PLATE, jobId: bare, config: STUB });
    assert.equal(outcome.kind, "abstained");
    if (outcome.kind !== "abstained") return;
    assert.match(outcome.reason, /no matching mobile-combustion factor/);
  });

  it("refuses rather than reaching out when it is neither keyed nor stubbed", async () => {
    // The production-like misconfiguration. It fails closed instead of quietly doing nothing, and
    // still does not name the plate.
    const outcome = await proposeFromRegistration(db, {
      registration: PLATE, jobId: JOB, config: { apiKey: null, allowStub: false },
    });
    assert.equal(outcome.kind, "abstained");
    if (outcome.kind !== "abstained") return;
    assert.ok(!outcome.reason.toUpperCase().includes("AB12"));
  });

  it("makes no network call on the stubbed path", async () => {
    // The same guarantee registrationTransience pins for the lookup, asserted through this route so
    // the assisted path cannot acquire one by composition.
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
    await proposeFromRegistration(db, {
      registration: PLATE, jobId: JOB, config: { apiKey: null, allowStub: true, fetchImpl },
    });
    assert.equal(called, false, "the stub resolves without reaching DVLA");
  });
});
