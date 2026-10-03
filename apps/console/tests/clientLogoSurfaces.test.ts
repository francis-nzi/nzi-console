import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/**
 * The client logo (CLIENT-02, ruled PR 4): upload or URL in the identity drawer; a URL is fetched by the server only for
 * a caller who may set the logo, and stored as a copy; the stored logo (never a remote address) on every job header.
 */
describe("the client logo surfaces", () => {
  it("fetches a URL only for a caller who may set the logo, and stores it exactly as an upload", () => {
    const route = read("apps/console/app/api/isolated/clients/[clientId]/logo/from-url/route.ts");
    const authorise = route.indexOf('requireCommandPrincipal(request, "client.logo.set")');
    const fetchAt = route.indexOf("fetchLogoFromUrl(");
    assert.ok(authorise > 0 && fetchAt > authorise, "client.logo.set is checked before anything is fetched");
    assert.match(route, /setClientLogo\(isolatedPool\(\), \{ clientId, fileName: fetched\.fileName, contentType: fetched\.contentType, dataBase64: fetched\.dataBase64 \}/);
    assert.doesNotMatch(route, /fetch\(/, "no direct fetch — only the hardened fetcher");
  });

  it("offers upload or a URL in the identity drawer, for the four types", () => {
    const identity = read("apps/console/app/clients/[clientId]/ClientIdentity.tsx");
    assert.match(identity, /logo\/from-url/);
    assert.match(identity, /PNG, SVG, JPEG or WebP/);
    assert.match(identity, /aria-label="Logo web address"/);
  });

  it("shows the client's stored logo on every family's job header", () => {
    for (const file of ["apps/console/app/jobs/CrpScopeWorkspace.tsx", "apps/console/app/jobs/FamilyWorkspace.tsx", "apps/console/app/jobs/lca/LcaWorkspace.tsx", "apps/console/app/jobs/training/TrainingWorkspace.tsx"]) {
      assert.match(read(file), /<JobClientMark header=\{(job\.)?header\} \/>/, file);
    }
    const mark = read("apps/console/app/jobs/JobClientMark.tsx");
    assert.match(mark, /\/api\/isolated\/clients\/\$\{encodeURIComponent\(header\.clientId\)\}\/logo\?v=/, "the stored copy, served by the console");
    assert.match(mark, /LogoMark/, "falls back to the monogram");
  });

  it("keeps the organisation's own logo to PNG or SVG", () => {
    assert.match(read("apps/console/app/admin/organisation/OrganisationBoard.tsx"), /organisationLogoContentTypes/);
    assert.doesNotMatch(read("apps/console/app/admin/organisation/OrganisationBoard.tsx"), /clientLogoContentTypes/);
  });
});
