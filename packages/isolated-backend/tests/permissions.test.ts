// NZC-022 — the permission matrix, enforced in the command layer.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { capabilities, commandDefinitions, commandGrantForRole, isCapability, ROLE_CAPABILITY_MATRIX, roleCapabilityGrants, staffRoles, type CommandInputMap, type StaffRole } from "@nzi/contracts";
import {
  approveScopeRow, AuthorizationError, capabilitiesFromRows, CommandValidationError, listAuditEvents, listPortalAccess, resolveStaffPrincipal,
  setPortalJobAccess, updateClient, upsertEmissionsTarget, type StaffPrincipal,
} from "../src/index";
import { withAccess } from "./support/access";

const here = dirname(fileURLToPath(import.meta.url));
const matrixMigration = readFileSync(resolve(here, "../migrations/0066_permission_matrix.sql"), "utf8");

/** The role→capability rows exactly as migration 0066 inserts them. */
const migrationRows = [...matrixMigration.matchAll(/\(1, '([a-z]+)', '([a-z._]+)', '(all|own_clients)'\)/g)].map(([, role, capability, scope]) => ({ role: role!, capability: capability!, scope: scope! }));

const context = (role: StaffRole, actorId: string, key: string, extra: { reason?: string; organisationId?: string } = {}) => ({
  organisationId: extra.organisationId ?? "org-a", actorId, principal: "staff" as const, idempotencyKey: key, correlationId: `corr-${key}`,
  grant: commandGrantForRole(role, extra.organisationId ?? "org-a", actorId), ...(extra.reason ? { reason: extra.reason } : {}),
});

type Call = { sql: string; values?: readonly unknown[] };
/** A client-update pool: the governed prior values are `before`; everything else succeeds. */
function clientPool(calls: Call[], before: Record<string, unknown>, access: { ownerUserId?: string | null; organisationId?: string } = {}) {
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("financial_year_end_month, baseline_period_start")) return { rows: [{ version: 3, financial_year_end_month: 3, baseline_period_start: null, baseline_period_end: null, baseline_scope1_tco2e: null, baseline_scope2_tco2e: null, baseline_scope3_tco2e: null, baseline_total_tco2e: null, ...before }] };
      if (sql.includes("UPDATE nzi_console.clients")) return { rows: [{ version: 4 }] };
      return { rows: [] };
    },
    release() {},
  };
  return withAccess({ connect: async () => client } as never, access);
}
const identity = { clientId: "client-a", expectedVersion: 3, name: "Synthetic Client", status: "active" as const, sector: "Retail", location: "Leeds", owner: "A. Owner" };

describe("the permission matrix (NZC-022)", () => {
  it("defines the capability enum exactly as PERMISSION_MATRIX.md enumerates it", () => {
    const doc = readFileSync(resolve(here, "../../../docs/PERMISSION_MATRIX.md"), "utf8");
    const documented = new Set([...doc.matchAll(/`([a-z]+\.[a-z_]+)`/g)].map(([, name]) => name!).filter((name) => !["financials.edit", "domain.action"].includes(name)));
    assert.deepEqual([...capabilities].sort(), [...documented].sort());
  });

  it("gives each role exactly its matrix capabilities — the code copy equals the migration rows", () => {
    for (const role of staffRoles) {
      const fromMigration = migrationRows.filter((row) => row.role === role).map(({ capability, scope }) => ({ capability, scope })).sort((a, b) => a.capability.localeCompare(b.capability));
      const fromCode = roleCapabilityGrants(role).map(({ capability, scope }) => ({ capability, scope })).sort((a, b) => a.capability.localeCompare(b.capability));
      assert.deepEqual(fromCode, fromMigration, role);
    }
    assert.equal(migrationRows.length, staffRoles.reduce((sum, role) => sum + Object.keys(ROLE_CAPABILITY_MATRIX[role]).length, 0));
  });

  it("matches the matrix cell by cell for the conditional and read-only rows", () => {
    const has = (role: StaffRole, capability: string) => ROLE_CAPABILITY_MATRIX[role][capability as never];
    assert.equal(Object.keys(ROLE_CAPABILITY_MATRIX.admin).length, capabilities.length);
    assert.equal(has("consultant", "baseline.rebaseline"), "own_clients");
    assert.equal(has("consultant", "portal.admin"), "own_clients");
    assert.equal(has("consultant", "audit.view"), "own_clients");
    assert.equal(has("finance", "audit.view"), "own_clients");
    assert.equal(has("consultant", "snapshot.review"), undefined);
    assert.equal(has("consultant", "report.publish"), undefined);
    assert.equal(has("reviewer", "report.edit"), undefined);
    assert.equal(has("reviewer", "scoperow.edit"), undefined);
    assert.equal(has("finance", "client.edit"), undefined);
    assert.deepEqual(Object.keys(ROLE_CAPABILITY_MATRIX.viewer).sort(), ["client.view", "report.view"]);
  });

  it("names only enum capabilities on commands, and no legacy or ad-hoc permission string survives in source", () => {
    for (const definition of Object.values(commandDefinitions)) assert.ok(isCapability(definition.permission), definition.key);
    const legacy = /["'`](financials\.edit|emissions\.data\.edit|emissions\.review|reports\.publish|clients\.create|jobs\.create|jobs\.stage\.change|datasets\.override|portal\.access\.manage|sales\.convert|staff\.access\.manage)["'`]/;
    const roots = ["../src", "../../contracts/src", "../../../apps/console/app"].map((path) => resolve(here, path));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { if (!["node_modules", ".next"].includes(entry.name)) walk(path); }
        else if (/\.(ts|tsx)$/.test(entry.name) && legacy.test(readFileSync(path, "utf8"))) offenders.push(path);
      }
    };
    roots.forEach(walk);
    assert.deepEqual(offenders, []);
  });

  it("resolves a principal from the current matrix rows only, dropping anything outside the enum", async () => {
    const rows = [...roleCapabilityGrants("reviewer").map((grant) => ({ matrix_version: 1, capability: grant.capability, scope: grant.scope })), { matrix_version: 1, capability: "financials.edit", scope: "all" }];
    assert.deepEqual(capabilitiesFromRows(rows), { matrixVersion: 1, capabilities: roleCapabilityGrants("reviewer") });
    const client = { async query(sql: string) { return sql.includes("staff_role_capabilities") ? { rows } : sql.includes("m.role_id") ? { rows: [{ role_id: "reviewer" }] } : { rows: [] }; }, release() {} };
    const principal = await resolveStaffPrincipal({ connect: async () => client } as never, { sessionId: "s", userId: "u", organisationId: "org-a", issuedAt: 1, expiresAt: 2 });
    assert.equal(principal.role, "reviewer");
    assert.deepEqual(principal.capabilities, roleCapabilityGrants("reviewer"));
  });

  it("refuses a retired role name rather than mapping it to anything", async () => {
    const client = { async query(sql: string) { return sql.includes("m.role_id") ? { rows: [{ role_id: "administrator" }] } : { rows: [] }; }, release() {} };
    await assert.rejects(() => resolveStaffPrincipal({ connect: async () => client } as never, { sessionId: "s", userId: "u", organisationId: "org-a", issuedAt: 1, expiresAt: 2 }));
  });
});

describe("the command runner's authoritative check (NZC-022)", () => {
  it("refuses a command whose role lacks the capability, before anything is written", async () => {
    for (const role of ["viewer", "reviewer", "finance"] as const) {
      const calls: Call[] = [];
      await assert.rejects(() => updateClient(clientPool(calls, {}), identity, context(role, "user-a", `deny-${role}`)), (error: unknown) => error instanceof AuthorizationError && error.permission === "client.edit");
      assert.ok(!calls.some((call) => call.sql.includes("UPDATE")), role);
    }
  });

  it("refuses a command without a grant, or with another user's or tenant's grant", async () => {
    const base = context("admin", "user-a", "no-grant");
    await assert.rejects(() => updateClient(clientPool([], {}), identity, { ...base, grant: undefined as never }), AuthorizationError);
    await assert.rejects(() => updateClient(clientPool([], {}), identity, { ...base, grant: commandGrantForRole("admin", "org-a", "user-b") }), (error: unknown) => error instanceof AuthorizationError && error.permission === "tenant");
    await assert.rejects(() => updateClient(clientPool([], {}), identity, { ...base, grant: commandGrantForRole("admin", "org-b", "user-a") }), (error: unknown) => error instanceof AuthorizationError && error.permission === "tenant");
  });

  it("refuses a record in another tenant (assert_client_access)", async () => {
    // The actor is an Admin of org-b; the client lives in org-a, so org-b's lookup finds nothing.
    const calls: Call[] = [];
    await assert.rejects(
      () => updateClient(clientPool(calls, {}, { organisationId: "org-a" }), identity, context("admin", "admin-b", "cross-tenant", { organisationId: "org-b" })),
      (error: unknown) => error instanceof AuthorizationError && error.permission === "tenant",
    );
    assert.ok(!calls.some((call) => call.sql.includes("UPDATE")));
  });

  it("audits a financial-year-end change with its prior value (client.edit)", async () => {
    const calls: Call[] = [];
    await updateClient(clientPool(calls, { financial_year_end_month: 3 }), { ...identity, financialYearEndMonth: 9 }, context("consultant", "consultant-a", "fye"));
    const audit = calls.find((call) => call.sql.includes("INSERT INTO nzi_console.audit_events"))!;
    assert.deepEqual(JSON.parse(String(audit.values?.[10])), { financialYearEndMonth: 3 });
    assert.equal(JSON.parse(String(audit.values?.[9])).changed.financialYearEndMonth, 9);
  });
});

describe("baseline.rebaseline (⚑ reason + governed event, own clients for a Consultant)", () => {
  const baseline = { baseline_period_start: "2022-04-01", baseline_period_end: "2023-03-31", baseline_total_tco2e: "900" };
  const rebaselined = { ...identity, baselinePeriodStart: "2022-04-01", baselinePeriodEnd: "2023-03-31", baselineTotalTco2e: 850, financialYearEndMonth: 3 };

  it("requires a reason, and records a governed event plus its own audit event", async () => {
    await assert.rejects(() => updateClient(clientPool([], baseline), rebaselined, context("admin", "admin-a", "no-reason")), (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "REASON_REQUIRED"));
    const calls: Call[] = [];
    await updateClient(clientPool(calls, baseline), rebaselined, context("admin", "admin-a", "with-reason", { reason: "Acquisition of Site B" }));
    const governed = calls.find((call) => call.sql.includes("INSERT INTO nzi_console.baseline_change_events"))!;
    assert.equal(governed.values?.[3], "Acquisition of Site B");
    assert.deepEqual(JSON.parse(String(governed.values?.[4])), { baselineTotalTco2e: 900 });
    assert.deepEqual(JSON.parse(String(governed.values?.[5])), { baselineTotalTco2e: 850 });
    assert.ok(calls.some((call) => call.sql.includes("INSERT INTO nzi_console.audit_events") && call.values?.[4] === "client_rebaselined"));
  });

  it("lets a Consultant re-baseline their own client only", async () => {
    await assert.rejects(
      () => updateClient(clientPool([], baseline, { ownerUserId: "someone-else" }), rebaselined, context("consultant", "consultant-a", "not-owned", { reason: "Restated" })),
      (error: unknown) => error instanceof AuthorizationError && error.permission === "baseline.rebaseline",
    );
    const calls: Call[] = [];
    await updateClient(clientPool(calls, baseline, { ownerUserId: "consultant-a" }), rebaselined, context("consultant", "consultant-a", "owned", { reason: "Restated" }));
    assert.ok(calls.some((call) => call.sql.includes("INSERT INTO nzi_console.baseline_change_events")));
  });

  it("treats setting a first baseline as an ordinary edit, not a re-baseline", async () => {
    const calls: Call[] = [];
    await updateClient(clientPool(calls, {}, { ownerUserId: "someone-else" }), rebaselined, context("consultant", "consultant-a", "initial"));
    assert.ok(!calls.some((call) => call.sql.includes("baseline_change_events")));
  });

  it("governs a change to a saved job target's baseline the same way", async () => {
    const pool = (calls: Call[]) => withAccess({ connect: async () => ({
      async query(sql: string, values?: readonly unknown[]) {
        calls.push({ sql, values });
        if (sql.includes("SELECT job_family FROM")) return { rows: [{ job_family: "crp" }] };
        if (sql.includes("FROM nzi_console.job_emissions_targets")) return { rows: [{ version: 2, baseline_year: 2022, baseline_tco2e: "900" }] };
        if (sql.includes("INSERT INTO nzi_console.job_emissions_targets")) return { rows: [{ version: 3 }] };
        return { rows: [] };
      }, release() {},
    }) } as never, { ownerUserId: "consultant-a" });
    const input: CommandInputMap["emissions.target.upsert"] = { jobId: "job-a", baselineYear: 2022, baselineTco2e: 850, interimYear: 2030, interimReductionPercent: 42, netZeroYear: 2050, expectedVersion: 2 };
    await assert.rejects(() => upsertEmissionsTarget(pool([]), input, context("consultant", "consultant-a", "target-no-reason")), (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "REASON_REQUIRED"));
    const calls: Call[] = [];
    await upsertEmissionsTarget(pool(calls), input, context("consultant", "consultant-a", "target-reason", { reason: "Corrected base year data" }));
    assert.ok(calls.some((call) => call.sql.includes("INSERT INTO nzi_console.baseline_change_events") && call.values?.[4] === "job_emissions_target"));
    // Unchanged baseline, other target fields changed: an ordinary target edit.
    const quiet: Call[] = [];
    await upsertEmissionsTarget(pool(quiet), { ...input, baselineTco2e: 900, interimReductionPercent: 50 }, context("consultant", "consultant-a", "target-quiet"));
    assert.ok(!quiet.some((call) => call.sql.includes("baseline_change_events")));
  });
});

describe("separation of duties on scope rows", () => {
  it("refuses the capturer's approval even after someone else calculated the row", async () => {
    const client = { async query(sql: string) {
      if (sql.includes("SELECT job_family FROM")) return { rows: [{ job_family: "crp" }] };
      if (sql.includes("SELECT version,enabled,calculated_tco2e")) return { rows: [{ version: 3, enabled: true, calculated_tco2e: "1.2", override_tco2e: null, quality_tier: "measured", provenance_json: { capturedBy: "consultant-a", calculatedBy: "consultant-b" } }] };
      return { rows: [] };
    }, release() {} };
    for (const actor of ["consultant-a", "consultant-b"]) {
      await assert.rejects(
        () => approveScopeRow(withAccess({ connect: async () => client } as never), { jobId: "job-a", rowIds: ["row-a"], expectedReviewVersion: 3 }, context("admin", actor, `self-${actor}`)),
        (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "INDEPENDENT_REVIEW_REQUIRED"),
        actor,
      );
    }
  });
});

describe("non-command checks use the same rule", () => {
  const principal = (role: StaffRole, userId = "consultant-a"): StaffPrincipal => ({ organisationId: "org-a", userId, sessionId: "s", issuedAt: 1, expiresAt: 2, role, matrixVersion: 1, capabilities: roleCapabilityGrants(role) });

  it("scopes portal.admin to a Consultant's own clients", async () => {
    const pool = (ownerUserId: string | null) => withAccess({ connect: async () => ({ async query(sql: string) { return sql.includes("SELECT u.client_id") ? { rows: [{ client_id: "client-a" }] } : { rows: [] }; }, release() {} }) } as never, { ownerUserId });
    await assert.rejects(() => setPortalJobAccess(pool("someone-else"), principal("consultant"), { portalUserId: "portal-a", jobId: "job-a", granted: true }), (error: unknown) => error instanceof AuthorizationError && error.permission === "portal.admin");
    const result = await setPortalJobAccess(pool("consultant-a"), principal("consultant"), { portalUserId: "portal-a", jobId: "job-a", granted: true });
    assert.equal(result.granted, true);
    await assert.rejects(() => setPortalJobAccess(pool("consultant-a"), principal("reviewer"), { portalUserId: "portal-a", jobId: "job-a", granted: true }), AuthorizationError);
  });

  it("filters the portal-user list and the audit trail to own clients for an own-scoped holder", async () => {
    const seen: Array<readonly unknown[] | undefined> = [];
    const client = { async query(sql: string, values?: readonly unknown[]) { if (sql.includes("FROM nzi_console.portal_users u")) seen.push(values); return { rows: [] }; }, release() {} };
    await listPortalAccess({ connect: async () => client } as never, principal("consultant"));
    await listPortalAccess({ connect: async () => client } as never, principal("admin", "admin-a"));
    assert.deepEqual(seen.map((values) => values?.[0]), ["consultant-a", null]);
    const auditValues: Array<readonly unknown[] | undefined> = [];
    await listAuditEvents({ query: async (_sql: string, values?: readonly unknown[]) => { auditValues.push(values); return { rows: [] }; } } as never, 50, { ownerUserId: "finance-a" });
    assert.deepEqual(auditValues[0], [50, "finance-a"]);
  });
});
