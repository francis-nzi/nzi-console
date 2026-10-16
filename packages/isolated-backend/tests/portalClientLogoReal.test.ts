import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, defaultReportSectionPlan, setReportSectionIncluded, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { getLogoAsset } from "../src/clientLogo";
import { publishCrpReport, validateCrpReport } from "../src/postgresCommands";
import { getGrantedPortalReport } from "../src/portalComposition";
import { withTenantRead } from "../src/postgres";

/**
 * The portal client-logo route (the composed@5 publish gate), against a real database. composed@5's cover draws the client's
 * logo the version froze; in the portal it loads through `/api/portal/logo-assets/{id}`, which reads `getLogoAsset` restricted to
 * the portal user's own client. So:
 * - the asset the client's published composition names — the one the version froze at validate, though the client's logo changed
 *   before publish — is served to that client's portal user (assets are append-only, so the issued cover keeps its logo);
 * - never to another client's portal user, whatever asset id is asked for.
 */
const ORG = "plogo-org";
const CLIENT = "plogo-client";
const OTHER = "plogo-other";
const JOB = "j-plogo";

describe("the portal serves a published report's frozen client logo to its own client only", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let count = 0;
  const context = (actor: string, role: StaffRole): CommandContext => {
    count += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `plogo-${count}`, correlationId: `corr-plogo-${count}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const logo = async (clientId: string, assetId: string) => {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>${assetId}</text></svg>`);
    await q(`INSERT INTO nzi_console.client_logo_assets (organisation_id, asset_id, client_id, file_name, content_type, byte_size, sha256, content, uploaded_by)
             VALUES ($1, $2, $3, 'logo.svg', 'image/svg+xml', $4, $5, $6, 'seed')`, [ORG, assetId, clientId, svg.length, sha(svg.toString()), svg]);
    await q(`UPDATE nzi_console.clients SET logo_asset_id = $3 WHERE organisation_id = $1 AND client_id = $2`, [ORG, clientId, assetId]);
  };
  /** What the portal route reads for a portal user of `clientId` (`getLogoAsset(db, assetId, { clientId: user.clientId })`). */
  const served = (clientId: string, assetId: string) => withTenantRead(database.pool, ORG, (db) => getLogoAsset(db, assetId, { clientId }));

  before(async () => {
    database = (await createDisposableDatabase("portalclientlogo"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'rev', 'reviewer', 'active', 'Rev')`, [ORG]);
    for (const id of [CLIENT, OTHER]) await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, $2, 'active', 'GBP')`, [ORG, id]);
    await logo(CLIENT, "logo-issued");
    await logo(OTHER, "logo-other");
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, 9791, 'crp', 'CRP', 'open', 'delivery', 2025)`, [ORG, JOB, CLIENT]);
    const payload = { jobNumber: "J-plogo", client: CLIENT, reportingYear: 2025, annualComparison: [],
      measurements: [{ rowId: "r-1", rowVersion: 1, scope: "1", scopeCode: "1", siteId: null, siteLabel: null, sourceLabel: "Gas", tco2e: 10, factorSet: "Gas · demo", qualityTier: "measured", factorSource: "dataset" }] };
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by, approved_by, approved_at)
             VALUES ($1, 'snap-plogo', $2, 1, 1, $3, $4::jsonb, 'prep', 'rev', now())`, [ORG, JOB, `sha256:${sha("snap-plogo")}`, JSON.stringify(payload)]);
    // This snapshot has no targets or intensity measures, so the plan leaves those sections out (validate's R4).
    const sectionPlan = setReportSectionIncluded(setReportSectionIncluded(defaultReportSectionPlan, "targets", false), "intensity", false);
    const reportVersionId = (await validateCrpReport(database.pool, { reviewedSnapshotId: "snap-plogo", manifestVersion: 1, sectionPlan }, context("rev", "reviewer"))).data.reportVersionId;
    // The client changes its logo after validate froze one onto the version: publish composes with the version's, not this.
    await logo(CLIENT, "logo-later");
    await publishCrpReport(database.pool, { reportVersionId, expectedStatus: "validated", expectedVersion: 1, manifestVersion: 1, reviewedSnapshotId: "snap-plogo" }, context("rev", "reviewer"));
    await q(`INSERT INTO nzi_console.portal_users (organisation_id, portal_user_id, client_id, status) VALUES ($1, 'p-user', $2, 'active')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.portal_access_grants (organisation_id, grant_id, client_id, portal_user_id, job_id, data_entry_starts_at, data_entry_expires_at)
             VALUES ($1, 'grant-plogo', $2, 'p-user', $3, now() - interval '1 day', now() + interval '30 days')`, [ORG, CLIENT, JOB]);
  });
  after(async () => { await database?.end(); });

  it("the client's copy of the composed@5 report names the logo the version froze — and the portal route serves exactly that asset", async () => {
    const view = await withTenantRead(database.pool, ORG, (db) => getGrantedPortalReport(db, { portalUserId: "p-user", clientId: CLIENT, jobId: JOB }));
    assert.equal(view?.state, "composed");
    if (view?.state !== "composed") throw new Error("expected a composed report");
    assert.equal(view.composition.renderer, "composed@5");
    assert.equal(view.composition.clientLogoAssetId, "logo-issued", "the version's frozen logo, not the client's later one");
    const asset = await served(CLIENT, view.composition.clientLogoAssetId!);
    assert.equal(asset?.assetId, "logo-issued");
    assert.equal(asset?.contentType, "image/svg+xml");
    assert.ok(asset?.content.toString().includes("logo-issued"), "the frozen bytes");
  });

  it("never serves another client's logo to a portal user, nor theirs to another client", async () => {
    assert.equal(await served(OTHER, "logo-issued"), null, "another client's portal user asking for this client's frozen logo");
    assert.equal(await served(CLIENT, "logo-other"), null, "this client's portal user asking for another client's logo");
    assert.equal(await served(CLIENT, "no-such-asset"), null, "an unknown asset");
  });
});
