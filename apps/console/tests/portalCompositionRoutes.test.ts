import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/**
 * F-4a (RULING-reporting-F4): the portal routes over the grant-checked composition reader — the portal's own session and
 * terms gate, the tenant read, no caching, read only — and the deliverables following the report the switcher names (D5).
 */
describe("the portal's composition, issuer-logo and deliverables routes (F-4a)", () => {
  const composition = read("apps/console/app/api/portal/jobs/[jobId]/published-report/composition/route.ts");
  const logo = read("apps/console/app/api/portal/jobs/[jobId]/published-report/issuer-logo/route.ts");

  it("the composition route reads through the portal session and the grant-checked reader, read only and uncached", () => {
    assert.match(composition, /const user = await currentPortalUserForData\(request\)/, "the portal session, terms accepted");
    assert.match(composition, /withTenantRead\(isolatedPool\(\), user\.organisationId, \(db\) => getGrantedPortalReport\(db, \{ portalUserId: user\.userId, clientId: user\.clientId, jobId, reportVersionId \}\)\)/);
    assert.match(composition, /"Cache-Control": "private, no-store"/);
    assert.match(composition, /state: "pre-composition"/, "D1: a version issued before compositions says so");
    assert.match(composition, /view\.composition\.reportVersionId !== view\.report\.reportVersionId \|\| view\.composition\.jobId !== jobId/, "never another version's document");
    assert.doesNotMatch(composition, /export async function (POST|PUT|PATCH|DELETE)/);
    assert.doesNotMatch(composition, /getReportComposition|requireIsolatedApiContext|currentStaff/, "never the staff reader or session");
  });

  it("the issuer logo is served only through the grant-checked reader (D4)", () => {
    assert.match(logo, /getGrantedIssuerLogo\(db, \{ organisationId: user\.organisationId, portalUserId: user\.userId, clientId: user\.clientId, jobId, assetId \}\)/);
    assert.match(logo, /logoResponse\(asset, request\.headers\.get\("if-none-match"\)\)/, "served as every logo is (nosniff, sandbox)");
    assert.doesNotMatch(logo, /readOrganisationLogo(Asset)?\(/, "never the organisation's assets directly");
  });

  it("the documents follow the report the switcher names, and their figures come from its frozen view (D5)", () => {
    const list = read("apps/console/app/api/portal/jobs/[jobId]/deliverables/route.ts");
    const kind = read("apps/console/app/api/portal/jobs/[jobId]/deliverables/[kind]/route.ts");
    const panel = read("apps/console/app/portal/PortalDeliverablesPanel.tsx");
    assert.match(list, /getGrantedPortalDeliverables\(db,\{portalUserId:user\.userId,clientId:user\.clientId,jobId,reportVersionId\}\)/);
    assert.match(kind, /getGrantedPortalDeliverables\(db,\{portalUserId:user\.userId,clientId:user\.clientId,jobId,reportVersionId:requestedVersion\}\)/);
    assert.match(kind, /portalPublicationEvidence\(result\.report,result\.composition\)/);
    assert.match(kind, /`Report scope: \$\{evidence\.scopeLabel\}`/);
    assert.match(panel, /\/deliverables\?reportVersionId=\$\{encodeURIComponent\(report\.reportVersionId\)\}/, "the panel asks for this report's documents");
  });
});
