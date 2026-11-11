import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * The portal Data view's category list follows the site tab (the CRM's #631 fix, for the client): re-read through
 * `data-categories` — the CRM's figures inside the client's profile gate, proved against a real database in `portalCaptureReal` —
 * with only the latest read landing. The bucket-grant `applicable-categories` route is untouched, and the portal gets no
 * "Unassigned" tab.
 */
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const view = read("apps/console/app/portal/jobs/[jobId]/data/PortalDataView.tsx");

describe("the portal category list honours the site tab", () => {
  it("re-reads the categories for the chosen site, and only the latest read lands", () => {
    assert.match(view, /fetch\(`\$\{base\}\/data-categories\?siteId=\$\{encodeURIComponent\(siteId\)\}`/);
    assert.match(view, /const request = \+\+latestCategories\.current;/);
    assert.match(view, /if \(request !== latestCategories\.current\) return;/);
    assert.match(view, /\}, \[base, siteId, loadedView, surface\]\);/, "a tab change, or a refreshed view, re-reads");
  });
  it("All sites is the Data view's own list; a site's list replaces it once read; a failed read says so", () => {
    assert.match(view, /if \(!siteId\) setShownCategories\(loadedView\.categories\);/);
    assert.match(view, /else if \(siteCategories\?\.state === "ready"\) setShownCategories\(siteCategories\.categories\);/);
    assert.match(view, /applicable=\{shownCategories \?\? view\.categories\}/);
    assert.match(view, /siteCategories\?\.state === "failed" \? <div className="nz-banner warn" role="alert">/);
  });
  it("adds no Unassigned tab to the portal", () => {
    assert.match(view, /<JobSiteTabs sites=\{view\.sites\} emissions=\{view\.emissions\} selected=\{siteId \|\| null\} onSelect=\{\(next\) => setSiteId\(next \?\? ""\)\} \/>/);
    assert.doesNotMatch(view, /unassigned|UNASSIGNED_SITE_ID/);
  });
});

describe("the routes", () => {
  const portal = read("apps/console/app/api/portal/jobs/[jobId]/data-categories/route.ts");
  const preview = read("apps/console/app/api/isolated/clients/[clientId]/portal-preview/jobs/[jobId]/data-categories/route.ts");
  it("the portal route reads through the job's grant and the profile gate, behind the portal-data flag", () => {
    assert.match(portal, /requirePortalData\(\);\s*const user = await currentPortalUserForData\(request\);/);
    assert.match(portal, /getPortalDataCategories\(isolatedPool\(\), user, jobId, siteId\)/);
    assert.doesNotMatch(portal, /export async function (POST|PUT|PATCH|DELETE)/);
  });
  it("the staff preview mirrors it, GET only, on the staff session", () => {
    assert.match(preview, /portalPreviewGet\(request, async \(principal\) => \{\s*requirePortalData\(\);/);
    assert.match(preview, /getPortalDataCategoriesForStaff\(isolatedPool\(\), principal, clientId, jobId, siteId\)/);
  });
  it("both assemble the client's list in one place, and the bucket-grant route is left as it was", () => {
    const capture = read("packages/isolated-backend/src/portalCapture.ts");
    assert.match(capture, /listJobApplicableCategories\(db, jobId, "crm", siteId\)\]\);\s*const categories = crm\.categories\.filter\(\(category\) => gate\.shows\(category\.code, category\.scope\)\);/);
    assert.match(capture, /assemblePortalCategories\(db, clientId, jobId, null\)/, "the Data view's own list is the same assembly");
    assert.match(read("packages/isolated-backend/src/portalPreviewReads.ts"), /assemblePortalCategories\(db, clientId, jobId, siteId\)/);
    assert.match(read("apps/console/app/api/portal/jobs/[jobId]/applicable-categories/route.ts"), /listJobApplicableCategories\(db, jobId, "portal"\)\)/);
    assert.ok(existsSync(new URL("../app/api/portal/jobs/[jobId]/applicable-categories/route.ts", import.meta.url)));
  });
});
