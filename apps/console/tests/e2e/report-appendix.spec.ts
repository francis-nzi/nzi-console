import { test, expect, type Locator, type Page } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverReportVersion } from "./lib/discover";
import { collectPageErrors, expectHealthyScreen } from "./lib/screen";
import { expectNoHorizontalOverflow, scanWithBaseline } from "./lib/axe";

// R5a — report audit appendices (NZC-051; docs/ACCEPTANCE_R5_PAGED_OUTPUT.md).
// Behind `report-paged`. Appendix 1 (Full Emissions Audit, one row per
// measurement) and Appendix 2 (by Site, Scope & Category) read the same
// frozen `measurements` the rest of the report already reads — no new
// backend. Once the appendix is present every assertion is a HARD
// precondition (fail loud, never a silent skip — stage-sections.spec.ts /
// data-assurance.spec.ts discipline). The ONE conditional skip below is for
// the flag not yet being live on the target — delete just that `test.skip`
// call to harden this spec the moment `report-paged` flips, same one-line
// change as every other flag-gated spec in this suite.

/** Hard precondition — the audit appendices must actually be rendered. */
async function openReportVersion(page: Page): Promise<{ errors: string[]; appendix: Locator }> {
  const report = await discoverReportVersion(page.request);
  expect(report, "staging must expose a published CRP report version (seed J000712)").toBeTruthy();
  const errors = collectPageErrors(page);
  await page.goto(`/reports/${report!.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load").catch(() => undefined);
  await expectHealthyScreen(page);
  const appendix = page.locator(".report-appendix");
  test.skip(
    (await appendix.count()) === 0,
    "report-paged not enabled on target (no .report-appendix) — harden this spec (remove the skip) as part of the flip PR",
  );
  return { errors, appendix };
}

test.describe("R5a — report audit appendices", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set (public smoke run)");

  test("Appendix 1 (Full Emissions Audit) and Appendix 2 (by Site, Scope & Category) render from the frozen snapshot", async ({ page }) => {
    const { errors, appendix } = await openReportVersion(page);

    await expect(appendix.getByRole("heading", { name: /Full Emissions Audit/ })).toBeVisible();
    await expect(appendix.getByRole("heading", { name: /Emissions by Site, Scope/ })).toBeVisible();

    // Appendix 1: one audit row per enabled measurement, non-zero.
    const auditRows = appendix.locator("table.report-audit-table").first().locator("tbody tr");
    expect(await auditRows.count()).toBeGreaterThan(0);

    // Appendix 2: at least one site table, each with a Total row.
    const siteTables = appendix.locator("table.report-audit-table");
    expect(await siteTables.count()).toBeGreaterThan(1);
    await expect(siteTables.last().locator("tr.total")).toBeVisible();

    // Still bound to the reviewed snapshot — data-report-ready untouched.
    await expect(page.locator(".report-sheet")).toHaveAttribute("data-report-ready", "true");

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("the audit table is a real paged-media table — repeating thead, row-atomic breaks", async ({ page }) => {
    await openReportVersion(page);

    // Print-only rules live in the report's own PRINT_CSS <style> tag — assert
    // they exist rather than trying to render an actual paginated PDF.
    const printCss = await page.locator("style").evaluateAll((nodes) => nodes.map((n) => n.textContent ?? "").join("\n"));
    expect(printCss).toMatch(/\.report-audit-table\s+thead\{display:table-header-group\}/);
    expect(printCss).toMatch(/\.report-audit-table\s+tr\{break-inside:avoid/);
    expect(printCss).toMatch(/\.report-appendix\{break-before:page\}/);
  });

  test("passes the axe baseline and holds the column with the appendix present", async ({ page }) => {
    await openReportVersion(page);
    await scanWithBaseline(page, "report-appendix");
    await expectNoHorizontalOverflow(page, "report version with appendices");
  });
});
