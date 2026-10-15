import {
  normaliseReportScope, reportScopeChoices, reportSectionPlanIssues, resolveReportSectionPlan, selectableScopeSites,
  WHOLE_CLIENT_SCOPE, type ReportComposition, type ReportScope, type ReportSectionPlan, type ReportSectionPlanOrigin,
} from "@nzi/contracts";
import { composeForSnapshot } from "./reportCompositions";
import { readOrganisationBrand } from "./organisationSettings";
import { validateCrpSnapshotManifest, type CrpSnapshotForManifest } from "./postgresCommands";
import { normaliseReportSectionPlan, readActiveReportProfile } from "./reportSectionPlanRecords";
import type { Queryable } from "./postgres";

/**
 * B2-2 (REVIEW-B2-1-and-B2-rulings, Q6 approved with B0's guardrails): the Report Studio's **draft** — what `report.validate`
 * would hold, and publish would then freeze, for a job's latest approved snapshot with the plan and scope the rail has chosen,
 * composed now and **stored nowhere**.
 *
 * It resolves exactly as validate does — the plan asked for, else the client's active report profile, else the default; the
 * scope normalised and held to the snapshot's own sites; the organisation's issuer and the profile's issuer line as they stand
 * now — and composes through the one compose path (`composeForSnapshot`) that the B0 preview and publish use. What validate
 * would refuse is returned as blockers beside the draft, in validate's own words; the draft is never a version. Run it inside
 * `withTenantRead` (a READ ONLY transaction), so nothing it touches can be written.
 */
export type ReportDraftBlocker = { field: string; code: string; message: string };
export type ReportDraftComposition = {
  composition: ReportComposition;
  draftedAt: string;
  snapshotId: string;
  snapshotVersion: number;
  /** The plan the draft is composed with, and where it came from — what validate would hold if nothing is changed. */
  sectionPlan: ReportSectionPlan;
  planOrigin: ReportSectionPlanOrigin;
  scope: ReportScope;
  /** The sites this snapshot can be scoped to, for the scope selector — the same choices preparation offers. */
  scopeChoices: ReturnType<typeof reportScopeChoices>;
  /** What validate would refuse, in its words. Empty: this plan and scope would validate. */
  blockers: ReportDraftBlocker[];
};

type DraftSnapshotRow = CrpSnapshotForManifest & { snapshot_id: string; snapshot_version: number; client_id: string;
  payload_json: CrpSnapshotForManifest["payload_json"] & { provenance?: { boundary?: { siteIds?: string[] } } | null } };

export async function draftReportComposition(db: Queryable, input: {
  organisationId: string; jobId: string; sectionPlan?: ReportSectionPlan | null; scope?: ReportScope | null; now?: Date;
}): Promise<ReportDraftComposition | null> {
  // The job's latest **approved** snapshot: the one validate could release (an unapproved one never reaches a report).
  const snapshot = (await db.query<DraftSnapshotRow>(
    `SELECT s.snapshot_id, s.snapshot_version, s.job_id, s.data_hash, s.created_at, s.payload_json, j.client_id
       FROM nzi_console.reviewed_crp_snapshots s
       JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (s.organisation_id, s.job_id)
      WHERE s.organisation_id = $1 AND s.job_id = $2 AND j.job_family = 'crp' AND s.approved_by IS NOT NULL
      ORDER BY s.snapshot_version DESC LIMIT 1`,
    [input.organisationId, input.jobId])).rows[0];
  if (!snapshot) return null;
  const blockers: ReportDraftBlocker[] = [];

  // The plan, exactly as validate resolves it. One that breaks the plan rules is a blocker, and the draft shows the plan
  // validate would otherwise fall back to (the profile's, else the default) — never a plan that could not be held.
  const profile = await readActiveReportProfile(db, input.organisationId, snapshot.client_id);
  let resolved = resolveReportSectionPlan(input.sectionPlan ? normaliseReportSectionPlan(input.sectionPlan) : null, profile);
  const planIssues = reportSectionPlanIssues(resolved.plan);
  if (planIssues.length) {
    blockers.push(...planIssues);
    resolved = resolveReportSectionPlan(null, profile);
    if (reportSectionPlanIssues(resolved.plan).length) resolved = resolveReportSectionPlan(null, null);
  }

  // The scope, exactly as validate holds it: a site scope may pick only the snapshot's own sites.
  let scope = normaliseReportScope(input.scope ?? WHOLE_CLIENT_SCOPE);
  if (scope.kind === "sites") {
    const selectable = new Set(selectableScopeSites(snapshot.payload_json));
    const outside = scope.siteIds.filter((id) => !selectable.has(id));
    if (outside.length || scope.siteIds.length === 0) {
      blockers.push({ field: "scope.siteIds", code: "SITE_NOT_SELECTABLE", message: scope.siteIds.length === 0 ? "Choose at least one site, or report on the whole client." : `${outside.length === 1 ? "A site is" : `${outside.length} sites are`} not in this snapshot's reporting boundary.` });
      scope = WHOLE_CLIENT_SCOPE;
    }
  }

  // The manifest, judged against this plan and the snapshot's years (Track A R4/R5, R7) — what validate checks.
  const manifest = validateCrpSnapshotManifest(snapshot.snapshot_id, snapshot, resolved.plan);
  if (!manifest.valid) blockers.push(...manifest.issues.map((issue) => ({ field: issue.chartId, code: issue.code.toUpperCase(), message: issue.message })));

  const brand = await readOrganisationBrand(db, input.organisationId);
  const draftedAt = (input.now ?? new Date()).toISOString();
  const composition = await composeForSnapshot(db, {
    organisationId: input.organisationId, reportVersionId: "draft", issuedAt: draftedAt,
    snapshotId: snapshot.snapshot_id, clientId: snapshot.client_id, scope, sectionPlan: resolved.plan,
    issuer: { displayName: brand.displayName, shortName: brand.shortName, footer: brand.footer, logoAssetId: brand.logoAssetId },
    issuerLine: profile?.issuerLine ?? null,
    // composed@5: the client's logo as validate would freeze it (the client record's, now).
    clientLogoAssetId: (await db.query<{ logo_asset_id: string | null }>(`SELECT logo_asset_id FROM nzi_console.clients WHERE client_id = $1`, [snapshot.client_id])).rows[0]?.logo_asset_id ?? null,
  });
  return {
    composition, draftedAt, snapshotId: snapshot.snapshot_id, snapshotVersion: snapshot.snapshot_version,
    sectionPlan: resolved.plan, planOrigin: resolved.origin, scope,
    scopeChoices: reportScopeChoices(snapshot.payload_json as never), blockers,
  };
}
