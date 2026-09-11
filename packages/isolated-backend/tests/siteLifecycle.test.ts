import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AuthorizationError, CommandValidationError, VersionConflictError, authorizeCommand, createClientSite, editSite, reinstateSite, recordSiteFloorArea, rolePermissions, setRegisteredOffice, vacateSite } from "../src/index";

// NZC-070 / NZC-071 — the site lifecycle commands against an in-memory fake of the
// client_sites rows they read and write. pg returns DATE columns as JS Dates, so the
// fake does too (local midnight), which is exactly what the range checks must handle.
type Site = { site_id: string; client_id: string; name: string; version: number; is_registered_office: boolean; in_service_from: Date | null; vacated_effective: Date | null };
const day = (iso: string) => new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

function sitePool(initial: Array<Partial<Site> & { site_id: string }> = []) {
  const sites = new Map<string, Site>(initial.map((site) => [site.site_id, { client_id: "client-a", name: site.site_id, version: 1, is_registered_office: false, in_service_from: null, vacated_effective: null, ...site }]));
  const floorAreas: Array<{ siteId: string; effectiveFrom: unknown; floorAreaM2: unknown }> = [];
  const audits: string[] = [];
  const stored = new Map<string, { request_hash: string; outcome_json: Record<string, unknown> }>();
  const client = {
    async query(sql: string, values: readonly unknown[] = []) {
      if (sql.includes("FROM nzi_console.command_idempotency")) { const hit = stored.get(String(values[1])); return { rows: hit ? [hit] : [] }; }
      if (sql.includes("INSERT INTO nzi_console.command_idempotency")) { stored.set(String(values[1]), { request_hash: String(values[3]), outcome_json: JSON.parse(String(values[4])) }); return { rows: [] }; }
      if (sql.includes("INSERT INTO nzi_console.audit_events")) { audits.push(String(values[4])); return { rows: [] }; }
      if (sql.includes("coalesce(c.reporting_from,j.start_date) AS period_start")) return { rows: values[1] === "job-crp" ? [{ client_id: "client-a", job_family: "crp", period_start: day("2025-04-01") }] : [] };
      if (sql.includes("SELECT client_id FROM nzi_console.clients")) return { rows: values[1] === "client-a" ? [{ client_id: "client-a" }] : [] };
      if (sql.includes("AND lower(trim(name))=lower(trim($3))")) return { rows: [...sites.values()].filter((site) => site.client_id === values[1] && site.name.trim().toLowerCase() === String(values[2]).trim().toLowerCase() && site.site_id !== values[3]).map(() => ({})) };
      if (sql.includes("SELECT name FROM nzi_console.client_sites") && sql.includes("is_registered_office=true")) return { rows: [...sites.values()].filter((site) => site.client_id === values[1] && site.is_registered_office).map((site) => ({ name: site.name })) };
      if (sql.includes("FROM nzi_console.client_sites WHERE organisation_id=$1 AND site_id=$2")) { const site = sites.get(String(values[1])); return { rows: site ? [site] : [] }; }
      if (sql.includes("INSERT INTO nzi_console.client_sites")) {
        sites.set(String(values[1]), { site_id: String(values[1]), client_id: String(values[2]), name: String(values[3]), version: 1, is_registered_office: Boolean(values[6]), in_service_from: values[5] ? day(String(values[5])) : null, vacated_effective: null });
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO nzi_console.client_site_floor_areas")) { floorAreas.push({ siteId: String(values[2]), effectiveFrom: sql.includes("NULL,$4") ? null : values[3], floorAreaM2: sql.includes("NULL,$4") ? values[3] : values[4] }); return { rows: [] }; }
      if (sql.includes("SET is_registered_office=false") && sql.includes("site_id<>$3")) {
        for (const site of sites.values()) if (site.client_id === values[1] && site.site_id !== values[2] && site.is_registered_office) { site.is_registered_office = false; site.version += 1; }
        return { rows: [] };
      }
      if (sql.startsWith("UPDATE nzi_console.client_sites SET") && sql.includes("RETURNING version")) {
        const site = sites.get(String(values[1]));
        if (!site || site.version !== values[2]) return { rows: [] };
        if (sql.includes("name=$4,in_service_from=$5")) { site.name = String(values[3]); site.in_service_from = values[4] ? day(String(values[4])) : null; }
        if (sql.includes("is_registered_office=$4")) site.is_registered_office = Boolean(values[3]);
        if (sql.includes("vacated_effective=$4")) site.vacated_effective = day(String(values[3]));
        if (sql.includes("vacated_effective=NULL")) site.vacated_effective = null;
        site.version += 1;
        return { rows: [{ version: site.version }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as never, sites, floorAreas, audits };
}

let key = 0;
const context = () => ({ organisationId: "org-a", actorId: "consultant-a", principal: "staff" as const, idempotencyKey: `site-${++key}`, correlationId: `corr-${key}` });
const rejectsWith = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === code));

describe("createClientSite — the one site.create (NZC-070)", () => {
  it("defaults a job-created site's in-service date to the job's reporting-period start", async () => {
    const state = sitePool();
    const result = await createClientSite(state.pool, { jobId: "job-crp", name: "Depot" }, context());
    assert.equal(result.data.inServiceFrom, "2025-04-01");
    assert.deepEqual(state.audits, ["client_site_created"]);
  });

  it("lets the job's default be overridden, including to 'before records'", async () => {
    const state = sitePool();
    assert.equal((await createClientSite(state.pool, { jobId: "job-crp", name: "HQ", inServiceFrom: null }, context())).data.inServiceFrom, null);
  });

  it("requires a stated date from the client workspace, and records an initial floor area", async () => {
    const state = sitePool();
    await rejectsWith(createClientSite(state.pool, { clientId: "client-a", name: "Yard" }, context()), "REQUIRED");
    const result = await createClientSite(state.pool, { clientId: "client-a", name: "Yard", inServiceFrom: "2026-01-05", floorAreaM2: 420 }, context());
    assert.equal(result.data.inServiceFrom, "2026-01-05");
    assert.deepEqual(state.floorAreas, [{ siteId: result.data.siteId, effectiveFrom: null, floorAreaM2: 420 }]);
  });

  it("returns validation errors — not raw 500s — for a duplicate name or a taken registered office", async () => {
    const state = sitePool([{ site_id: "hq", name: "Head office", is_registered_office: true }]);
    await rejectsWith(createClientSite(state.pool, { clientId: "client-a", name: " head office ", inServiceFrom: null }, context()), "DUPLICATE");
    await rejectsWith(createClientSite(state.pool, { clientId: "client-a", name: "Annex", inServiceFrom: null, isRegisteredOffice: true }, context()), "REGISTERED_OFFICE_TAKEN");
  });

  it("is idempotent on its key", async () => {
    const state = sitePool();
    const ctx = context();
    const first = await createClientSite(state.pool, { clientId: "client-a", name: "Store", inServiceFrom: null }, ctx);
    const replay = await createClientSite(state.pool, { clientId: "client-a", name: "Store", inServiceFrom: null }, ctx);
    assert.equal(replay.replayed, true);
    assert.equal(replay.data.siteId, first.data.siteId);
    assert.equal(state.sites.size, 1);
  });
});

describe("site lifecycle commands (NZC-070)", () => {
  it("editSite compares dates as dates, so the range check fires in code (pg returns DATE as a JS Date)", async () => {
    const state = sitePool([{ site_id: "depot", in_service_from: day("2020-01-01"), vacated_effective: day("2025-07-01") }]);
    await rejectsWith(editSite(state.pool, { siteId: "depot", name: "Depot", inServiceFrom: "2025-07-01", expectedVersion: 1 }, context()), "INVALID_RANGE");
    const saved = await editSite(state.pool, { siteId: "depot", name: "Trafford depot", inServiceFrom: "2019-06-01", expectedVersion: 1 }, context());
    assert.equal(saved.data.version, 2);
    assert.equal(state.sites.get("depot")!.name, "Trafford depot");
  });

  it("moves the registered office — at most one per client", async () => {
    const state = sitePool([{ site_id: "hq", is_registered_office: true }, { site_id: "annex" }]);
    await setRegisteredOffice(state.pool, { siteId: "annex", isRegisteredOffice: true, expectedVersion: 1 }, context());
    assert.equal(state.sites.get("annex")!.is_registered_office, true);
    assert.equal(state.sites.get("hq")!.is_registered_office, false);
  });

  it("will not make a vacated site the registered office", async () => {
    const state = sitePool([{ site_id: "old", vacated_effective: day("2024-01-01") }]);
    await rejectsWith(setRegisteredOffice(state.pool, { siteId: "old", isRegisteredOffice: true, expectedVersion: 1 }, context()), "SITE_VACATED");
  });

  it("requires an effective date to vacate, and blocks vacating the registered office until reassigned", async () => {
    const state = sitePool([{ site_id: "hq", name: "HQ", is_registered_office: true }, { site_id: "depot", in_service_from: day("2020-01-01") }]);
    await rejectsWith(vacateSite(state.pool, { siteId: "depot", effectiveDate: "", expectedVersion: 1 }, context()), "REQUIRED");
    await rejectsWith(vacateSite(state.pool, { siteId: "hq", effectiveDate: "2026-01-01", expectedVersion: 1 }, context()), "REGISTERED_OFFICE");
    await rejectsWith(vacateSite(state.pool, { siteId: "depot", effectiveDate: "2020-01-01", expectedVersion: 1 }, context()), "INVALID_RANGE");
    await vacateSite(state.pool, { siteId: "depot", effectiveDate: "2025-04-01", expectedVersion: 1 }, context());
    assert.equal(state.sites.get("depot")!.vacated_effective!.getMonth(), 3);
  });

  it("reinstates a vacated site, and refuses one that is not vacated", async () => {
    const state = sitePool([{ site_id: "depot", vacated_effective: day("2025-04-01") }, { site_id: "hq" }]);
    await reinstateSite(state.pool, { siteId: "depot", expectedVersion: 1 }, context());
    assert.equal(state.sites.get("depot")!.vacated_effective, null);
    await rejectsWith(reinstateSite(state.pool, { siteId: "hq", expectedVersion: 1 }, context()), "NOT_VACATED");
  });

  it("appends an effective-dated floor area and versions the site (NZC-071)", async () => {
    const state = sitePool([{ site_id: "hq" }, { site_id: "depot", vacated_effective: day("2025-04-01") }]);
    const result = await recordSiteFloorArea(state.pool, { siteId: "hq", floorAreaM2: 1250, effectiveFrom: "2025-04-01", expectedVersion: 1 }, context());
    assert.equal(result.data.version, 2);
    assert.deepEqual(state.floorAreas, [{ siteId: "hq", effectiveFrom: "2025-04-01", floorAreaM2: 1250 }]);
    await rejectsWith(recordSiteFloorArea(state.pool, { siteId: "depot", floorAreaM2: 10, effectiveFrom: "2025-05-01", expectedVersion: 1 }, context()), "INVALID_RANGE");
    await rejectsWith(recordSiteFloorArea(state.pool, { siteId: "hq", floorAreaM2: 0, effectiveFrom: null, expectedVersion: 2 }, context()), "INVALID");
  });

  it("rejects a stale version rather than half-applying", async () => {
    const state = sitePool([{ site_id: "hq", version: 3 }]);
    await assert.rejects(editSite(state.pool, { siteId: "hq", name: "HQ", inServiceFrom: null, expectedVersion: 2 }, context()), VersionConflictError);
  });

  it("gates every site mutation on emissions.data.edit", () => {
    const principal = (role: keyof typeof rolePermissions) => ({ sessionId: "s", userId: "u", organisationId: "org-a", issuedAt: 0, expiresAt: 0, role, permissions: rolePermissions[role] });
    for (const key of ["site.create", "site.edit", "site.registeredOffice", "site.vacate", "site.reinstate", "site.floorArea.record"] as const) {
      assert.doesNotThrow(() => authorizeCommand(principal("consultant"), key), key);
      assert.throws(() => authorizeCommand(principal("read-only"), key), AuthorizationError, key);
      assert.throws(() => authorizeCommand(principal("reviewer"), key), AuthorizationError, key);
    }
  });
});
