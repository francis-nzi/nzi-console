import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { environmentBadge, serviceEnvironment } from "../app/lib/environment";
import { ADMIN_ITEMS, ADMIN_NAV } from "../app/admin/adminNav";

/**
 * The admin section (admin Phase A1). The boundary is on the server: every admin page checks access itself before it
 * reads anything, because a page renders in parallel with its layout. The rail follows the approved design, with the
 * unbuilt areas shown and phase-badged (ruled P9). The environment badge says what the running service is.
 */
const here = dirname(fileURLToPath(import.meta.url));
const adminDir = join(here, "../app/admin");
const pages = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? pages(path) : name === "page.tsx" ? [path] : [];
});

describe("admin access is checked by every admin page", () => {
  const found = pages(adminDir);

  it("finds the admin pages", () => {
    assert.deepEqual(found.map((path) => relative(adminDir, path).replace(/\\/g, "/")).sort(), ["[section]/page.tsx", "crm-pipeline/page.tsx", "custom-fields/page.tsx", "file-types/page.tsx", "job-types/page.tsx", "lookups/page.tsx", "message-templates/page.tsx", "milestone-templates/page.tsx", "organisation/page.tsx", "page.tsx", "service-catalogue/page.tsx", "suppliers/page.tsx", "tax-currency/currencies/page.tsx", "tax-currency/page.tsx", "tax-currency/vat-rates/page.tsx", "team/page.tsx"]);
  });

  for (const path of pages(adminDir)) {
    const name = relative(adminDir, path).replace(/\\/g, "/");
    it(`${name} checks adminAccess and returns before any read`, () => {
      const source = readFileSync(path, "utf8");
      const check = source.indexOf(`if (access.state !== "allowed") return null;`);
      assert.ok(source.indexOf("await adminAccess()") >= 0 && check > source.indexOf("await adminAccess()"), "resolves access, then refuses");
      for (const read of ["withTenantRead(", "getAdminOverview(", "isolatedPool()", "listReferenceValuesPage(", "listLookupCategories(", "listJobTypesPage(", "listJobTypePickers(", "listMilestoneTemplates(", "listFileTypesPage(", "listVatRatesPage(", "listCurrenciesPage(", "listJobItemsPage(", "listJobItemPickers(", "listJobTypeTemplates(", "listTemplateCatalogue(", "listSuppliersPage(", "readSupplierParts(", "listMessageTemplates(", "listBdStagesPage(", "listCustomFieldsPage(", "listStaffPage(", "listStaffPickers(", "readOrganisationProfile(", "readOrganisationBank(", "listIntensityDefaults(", "countClientsWithoutMetrics("]) {
        const at = source.indexOf(read);
        if (at >= 0) assert.ok(at > check, `${read} comes after the access check`);
      }
    });
  }

  it("the access check fails closed — every non-allowed path is a stated reason", () => {
    const source = readFileSync(join(adminDir, "adminAccess.ts"), "utf8");
    assert.match(source, /holdsAdmin = \(capabilities: readonly CapabilityGrant\[\]\) => capabilities.some\(\(grant\) => grant.capability.startsWith\("admin."\)\)/);
    for (const state of ["forbidden", "signed-out", "unavailable"]) assert.ok(source.includes(`state: "${state}"`), state);
    assert.match(source, /NZI_DATA_MODE !== "isolated-api"/, "no data service, no admin");
  });
});

describe("the admin rail follows the approved design", () => {
  it("has the design's groups, in order", () => {
    assert.deepEqual(ADMIN_NAV.map((group) => group.group), [null, "Foundation", "Delivery", "Commercial", "Engagement", "Carbon data"]);
  });

  it("shows every unbuilt area with its roadmap phase (ruled P9), and links each to its own page", () => {
    const LIVE = ["overview", "lookups", "team", "organisation", "job-types", "milestone-templates", "file-types", "tax-currency", "service-catalogue", "suppliers", "message-templates", "crm-pipeline", "custom-fields"];
    const unbuilt = ADMIN_ITEMS.filter((item) => !LIVE.includes(item.id));
    assert.ok(unbuilt.every((item) => item.phase && item.href === `/admin/${item.id}`));
    assert.equal(ADMIN_ITEMS.find((item) => item.id === "lookups")?.phase, undefined, "Lookups is live (A2)");
    assert.equal(ADMIN_ITEMS.find((item) => item.id === "job-types")?.phase, undefined, "Job types is live (C1)");
    assert.equal(ADMIN_ITEMS.find((item) => item.id === "milestone-templates")?.phase, undefined, "Milestone templates is live (C2)");
    assert.equal(ADMIN_ITEMS.find((item) => item.id === "file-types")?.phase, undefined, "File types is live (C3)");
    assert.equal(ADMIN_ITEMS.find((item) => item.id === "team")?.phase, undefined, "Team & access is live (B1)");
    assert.equal(ADMIN_ITEMS.find((item) => item.id === "organisation")?.phase, undefined, "Organisation is live (D1)");
    assert.equal(ADMIN_ITEMS.find((item) => item.id === "tax-currency")?.phase, undefined, "Tax & currency is live (E1)");
    assert.equal(ADMIN_ITEMS.find((item) => item.id === "service-catalogue")?.phase, undefined, "Service catalogue is live (E2)");
    assert.equal(ADMIN_ITEMS.find((item) => item.id === "suppliers")?.phase, undefined, "Suppliers is live (E4)");
    assert.equal(ADMIN_ITEMS.find((item) => item.id === "message-templates")?.phase, undefined, "Message templates is live (F1)");
    assert.equal(ADMIN_ITEMS.find((item) => item.id === "crm-pipeline")?.phase, undefined, "CRM & pipeline is live (F2)");
    assert.equal(ADMIN_ITEMS.find((item) => item.id === "custom-fields")?.capability, "admin.settings", "Custom fields is live (F3), under admin.settings (F-Q5)");
  });

  it("names the governing capability wherever a phase's writes have one", () => {
    const capability = Object.fromEntries(ADMIN_ITEMS.map((item) => [item.id, item.capability]));
    assert.deepEqual([capability.lookups, capability.team, capability.organisation, capability["milestone-templates"]],
      ["admin.lookups", "admin.users", "admin.settings", "admin.templates"]);
  });

  it("appears in the console's rail only for an admin-capability holder", () => {
    const nav = readFileSync(join(here, "../app/lib/nav.ts"), "utf8");
    assert.match(nav, /\{ id: "admin", label: "Admin", icon: "settings", href: "\/admin", capabilityPrefix: "admin." \}/);
  });
});

describe("the environment badge says what the running service is", () => {
  it("reads the isolated staging service as such", () => {
    const environment = serviceEnvironment({ NEXT_PUBLIC_APP_ENV: "staging", NZI_DATA_MODE: "isolated-api", NZI_WRITE_API_ENABLED: "true" });
    assert.deepEqual(environmentBadge(environment), { label: "Staging · isolated", detail: "Reads and writes the isolated, non-production database. Writes are enabled." });
  });
  it("never claims a database where there is none", () => {
    assert.equal(environmentBadge(serviceEnvironment({})).label, "Local · fixture data");
  });
  it("is the same derivation the health check reports", () => {
    assert.match(readFileSync(join(here, "../app/api/health/route.ts"), "utf8"), /\.\.\.serviceEnvironment\(\)/);
  });
});
