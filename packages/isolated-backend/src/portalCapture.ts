import type { CommandInputMap, CommandContext, FactorOption, JobApplicableCategories, PortalOfferedProfile, ScopeRowReadModel } from "@nzi/contracts";
import { AuthorizationError, type PortalPrincipal } from "./auth";
import { CommandValidationError, runPostgresCommand, scopeRowCreateHandler, scopeRowUpdateHandler, type CreateScopeRowResult, type StoredOutcome, type UpdateScopeRowResult } from "./postgresCommands";
import { enabledHandler, type ScopeRowStateResult } from "./scopeRowState";
import { clientCategoryGate, portalFacingProfile } from "./portalProfile";
import { listJobApplicableCategories, listJobFactorOptions, listJobPurchasedGoodsCategories, listJobReportingMonths, listJobSites, listScopeRows } from "./readModels";
import { listScopeRowAuditEvents } from "./scopeRowHistory";
import { getPortalDataEntryAccess, type PortalDataEntryAccess } from "./portalAccess";
import { withTenantRead, type PoolLike, type Queryable } from "./postgres";

/**
 * Portal data-entry phase 2 — the client enters data on the job's own scope rows (RULING-portal-dataentry-02; BUILD-portal-
 * dataentry-phase2 §1, §2, §6; the points settled 22 Oct are in `_handoff/portal-dataentry-phase2-GROUNDING.md`).
 *
 * ## One write, not two
 * Each command runs the CRM's own handler — `scopeRowCreateHandler`, `scopeRowUpdateHandler`, the deactivate handler — as a
 * portal principal, through `runPostgresCommand`. So a client row is resolved (declared factor, applicability filing,
 * variant-base refusal), unit-reconciled, site- and PG&S-checked and evidenced exactly as a member of staff's, and audit,
 * outbox and idempotency come with it. What differs is said here and nowhere else:
 *  - **who**: the runner authorizes a portal command by the user's live access grant on the job and its open data-entry
 *    window (`authorizePortalCommand`) — never a staff capability;
 *  - **what**: the row's category must be one the client sees (scope ∧ category, the phase-1 profile), the staff-only fields
 *    are refused (`PORTAL_STAFF_ONLY_FIELDS`), and a client edits only a row a client captured that is still pending;
 *  - **how it lands**: always pending, never reviewed — the CRM handler records `capturedAs: "client-portal"` and the portal
 *    user, with no staff `capturedBy`, and the database's own review-evidence check holds a pending row's review fields NULL.
 *    The client can never review, approve or calculate (NZC-022); staff review stays the independent check.
 */

/** A client may change a row a client captured, while it waits on staff review (settled 22 Oct). */
export const CLIENT_ROW_NOT_EDITABLE = "CLIENT_ROW_NOT_EDITABLE";
export const CATEGORY_NOT_AVAILABLE = "CATEGORY_NOT_AVAILABLE";
export const ACTION_NOT_OFFERED = "ACTION_NOT_OFFERED";

const categoryOf = (row: { categoryCode?: string | null; scope: string }) => row.categoryCode?.trim() || (/^3\.\d+$/.test(row.scope) ? row.scope : null);

/** The portal user's live access grant on the job (any window), or a refusal that names nothing. */
export async function assertPortalJobAccess(db: Queryable, principal: Pick<PortalPrincipal, "organisationId" | "userId" | "clientId">, jobId: string): Promise<void> {
  const held = await db.query(
    `SELECT 1 FROM nzi_console.portal_access_grants g JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (g.organisation_id, g.job_id)
      WHERE g.organisation_id = $1 AND g.portal_user_id = $2 AND g.client_id = $3 AND g.job_id = $4 AND g.revoked_at IS NULL AND j.client_id = $3`,
    [principal.organisationId, principal.userId, principal.clientId, jobId]);
  if (!held.rows[0]) throw new AuthorizationError("tenant", "This job is not available to your account.");
}

async function requireShownCategory(db: Queryable, clientId: string, row: { categoryCode?: string | null; scope: string }): Promise<void> {
  const code = categoryOf(row);
  const gate = await clientCategoryGate(db, clientId);
  // Said without saying why: a hidden category is absent for the client, never "hidden" (NZC-110).
  if (!code || !gate.shows(code, row.scope)) throw new CommandValidationError([{ field: "categoryCode", code: CATEGORY_NOT_AVAILABLE, message: "That category isn't open for entry here." }]);
}

/** A row the client may change: in this job, live, a client's capture, still pending, enabled, in a category the client sees. */
async function requireClientEditableRow(db: Queryable, context: CommandContext, jobId: string, rowId: string): Promise<void> {
  const row = (await db.query<{ scope: string; category_code: string | null; review_status: string; enabled: boolean; origin: string; captured_as: string | null }>(
    `SELECT scope, category_code, review_status, enabled, origin, provenance_json->>'capturedAs' AS captured_as
       FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $2 AND scope_row_id = $3`,
    [context.organisationId, jobId, rowId])).rows[0];
  if (!row) throw new CommandValidationError([{ field: "rowId", code: "NOT_FOUND", message: "That entry was not found." }]);
  await requireShownCategory(db, context.portal!.clientId, { categoryCode: row.category_code, scope: row.scope });
  if (row.origin !== "live" || row.captured_as !== "client-portal" || row.review_status !== "pending" || !row.enabled) {
    throw new CommandValidationError([{ field: "rowId", code: CLIENT_ROW_NOT_EDITABLE,
      message: "This entry can't be changed here: only entries made in the portal can be, while they wait for review. Ask your adviser to change it." }]);
  }
}

/** The CRM's create input for a client's entry: the staff-only fields fixed, never taken from the request. */
const asCrmCreate = (input: CommandInputMap["portal.scope.row.create"]): CommandInputMap["scope.row.create"] =>
  ({ ...input, qualityTier: null, dataConfidence: null, overrideTco2e: null, overrideReason: null, factorSource: "dataset", clientFactorId: null, isCustomEntry: false, applyPct: 100, usageTypeId: undefined, capturedVia: "manual" });

export function createPortalScopeRow(pool: PoolLike, input: CommandInputMap["portal.scope.row.create"], context: CommandContext): Promise<StoredOutcome<CreateScopeRowResult>> {
  return runPostgresCommand(pool, "portal.scope.row.create", input, context, async (db) => {
    await requireShownCategory(db, context.portal!.clientId, input);
    const created = await scopeRowCreateHandler(asCrmCreate(input), context)(db);
    return { ...created, topic: "portal.scope.row.created" };
  });
}

export function updatePortalScopeRow(pool: PoolLike, input: CommandInputMap["portal.scope.row.update"], context: CommandContext): Promise<StoredOutcome<UpdateScopeRowResult>> {
  return runPostgresCommand(pool, "portal.scope.row.update", input, context, async (db) => {
    await requireClientEditableRow(db, context, input.jobId, input.rowId);
    await requireShownCategory(db, context.portal!.clientId, input);
    const updated = await scopeRowUpdateHandler({ ...asCrmCreate(input), rowId: input.rowId, expectedVersion: input.expectedVersion, enabled: true }, context)(db);
    return { ...updated, topic: "portal.scope.row.updated" };
  });
}

/** Off unless the client's profile offers it (`deactivate`); the same row rule as an edit. */
export function deactivatePortalScopeRow(pool: PoolLike, input: CommandInputMap["portal.scope.row.deactivate"], context: CommandContext): Promise<StoredOutcome<ScopeRowStateResult>> {
  return runPostgresCommand(pool, "portal.scope.row.deactivate", input, context, async (db) => {
    const { profile } = await portalFacingProfile(db, context.portal!.clientId);
    if (!profile.actions.includes("deactivate")) throw new CommandValidationError([{ field: "rowId", code: ACTION_NOT_OFFERED, message: "Deactivating an entry isn't available here. Ask your adviser." }]);
    await requireClientEditableRow(db, context, input.jobId, input.rowId);
    const result = await enabledHandler(input, context, false)(db);
    return { ...result, topic: "portal.scope.row.deactivated" };
  });
}

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Staff identity is not the client's to see (as the client copy of a report): every "who" key, at any depth, goes. */
const STAFF_IDENTITY_KEYS = new Set(["capturedBy", "calculatedBy", "reviewedBy", "approvedBy", "decidedBy", "actor", "actorId", "createdBy", "updatedBy"]);
function withoutStaffIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutStaffIdentity);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !STAFF_IDENTITY_KEYS.has(key)).map(([key, inner]) => [key, withoutStaffIdentity(inner)]));
}

/** A row as the client sees it: the CRM's own read model, with no staff identity, and whether the client may change it. */
export type PortalScopeRow = Omit<ScopeRowReadModel, "reviewedBy" | "reviewerNote"> & { editable: boolean };
export function clientFacingScopeRow(row: ScopeRowReadModel): PortalScopeRow {
  const { reviewedBy: _reviewer, reviewerNote: _note, ...rest } = row as ScopeRowReadModel & { reviewedBy?: unknown; reviewerNote?: unknown };
  const capturedAs = (row.provenance as { capturedAs?: unknown }).capturedAs;
  return {
    ...rest,
    provenance: withoutStaffIdentity(row.provenance) as Record<string, unknown>,
    lineage: withoutStaffIdentity(row.lineage) as ScopeRowReadModel["lineage"],
    editable: row.origin !== "migrated" && capturedAs === "client-portal" && row.reviewStatus === "pending" && row.enabled !== false,
  } as PortalScopeRow;
}

/**
 * Everything the client's Data view reads, in one tenant read, narrowed by the profile: the offered profile, the data-entry
 * window, the categories the client sees with the CRM's own server totals and completeness, those categories' rows, and the
 * job's dataset factors (the client picks factors as staff do, settled 22 Oct — never a client factor), sites, PG&S
 * categories and reporting months.
 */
export type PortalDataView = {
  profile: PortalOfferedProfile;
  access: PortalDataEntryAccess | null;
  categories: JobApplicableCategories;
  rows: PortalScopeRow[];
  factors: FactorOption[];
  sites: Array<{ id: string; name: string }>;
  purchasedGoodsCategories: Array<{ id: string; name: string }>;
  reportingMonths: string[];
};
export async function getPortalDataView(pool: PoolLike, principal: PortalPrincipal, jobId: string, now = new Date()): Promise<PortalDataView> {
  const access = await getPortalDataEntryAccess(pool, principal, jobId, now);
  return withTenantRead(pool, principal.organisationId, async (db) => {
    await assertPortalJobAccess(db, principal, jobId);
    return assemblePortalDataView(db, principal.clientId, jobId, access);
  });
}

/**
 * The Data view's assembly, once, for whichever authorizer opened the read — the portal grant (`getPortalDataView`) or the staff
 * preview (`getPortalDataViewForStaff`). Only who may ask and where `clientId` comes from differ; what the client sees is this.
 */
export async function assemblePortalDataView(db: Queryable, clientId: string, jobId: string, access: PortalDataEntryAccess | null): Promise<PortalDataView> {
  const [{ profile }, gate, crm, rows, factors, sites, pgs, months] = await Promise.all([
    portalFacingProfile(db, clientId), clientCategoryGate(db, clientId), listJobApplicableCategories(db, jobId, "crm"),
    listScopeRows(db, jobId), listJobFactorOptions(db, jobId), listJobSites(db, jobId), listJobPurchasedGoodsCategories(db, jobId), listJobReportingMonths(db, jobId),
  ]);
  const categories = crm.categories.filter((category) => gate.shows(category.code, category.scope));
  return {
    profile, access,
    // The CRM's own server metrics (entry count, tCO₂e, completeness), for the categories the client sees — never recomputed.
    categories: { audience: "portal", includedScopes: crm.includedScopes.filter((scope) => categories.some((category) => category.scope === scope)), categories },
    rows: rows.filter((row) => gate.shows(categoryOf(row), row.scope)).map(clientFacingScopeRow),
    factors: factors.filter((factor) => factor.factorSource !== "client"),
    sites: sites.filter((site) => site.included !== false).map((site) => ({ id: site.id, name: site.name })),
    purchasedGoodsCategories: pgs, reportingMonths: months,
  };
}

/** A row's History, as the client sees it: what happened and when, by "you" or "your adviser" — never a member of staff's name. */
export type PortalRowHistoryEntry = { at: string; who: "you" | "adviser" | "system"; action: string };
export async function getPortalRowHistory(pool: PoolLike, principal: PortalPrincipal, jobId: string, rowId: string): Promise<PortalRowHistoryEntry[]> {
  return withTenantRead(pool, principal.organisationId, async (db) => {
    await assertPortalJobAccess(db, principal, jobId);
    return assemblePortalRowHistory(db, principal.clientId, jobId, rowId);
  });
}

/** A row's History assembly, shared by the portal and the staff preview as the Data view's is. */
export async function assemblePortalRowHistory(db: Queryable, clientId: string, jobId: string, rowId: string): Promise<PortalRowHistoryEntry[]> {
  const row = (await db.query<{ scope: string; category_code: string | null }>(
    `SELECT scope, category_code FROM nzi_console.job_scope_rows WHERE job_id = $1 AND scope_row_id = $2`, [jobId, rowId])).rows[0];
  const gate = await clientCategoryGate(db, clientId);
  if (!row || !gate.shows(categoryOf({ categoryCode: row.category_code, scope: row.scope }), row.scope)) throw new AuthorizationError("tenant", "That entry is not available to your account.");
  const events = await listScopeRowAuditEvents(db, jobId, rowId);
  return events.map((event) => ({ at: event.at, who: event.principal === "portal" ? "you" : event.principal === "staff" ? "adviser" : "system", action: event.action }));
}
