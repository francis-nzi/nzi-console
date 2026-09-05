import { test, expect, type Page } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverLcaJob } from "./lib/discover";
import { collectPageErrors, expectHealthyScreen } from "./lib/screen";
import { expectNoHorizontalOverflow, scanWithBaseline } from "./lib/axe";

// Track C — LCA/PCF reference module, slice 3 (Transport legs; L3;
// docs/ACCEPTANCE_LCA_MODULE_SLICE3.md). A2/A4/C2 line items only. Job '714'
// (Verdant Foods, lca) is seeded with an A4 "Inbound tray shipment" line item
// carrying a three-leg geocoded journey
// (packages/isolated-backend/seeds/0006_synthetic_lca_transport_legs.sql), so
// this suite never has to skip for want of a line item to discover.
//
// Once the flag is live every assertion below is a HARD precondition (fail
// loud, never a silent skip). The ONE conditional skip is for the flag not
// yet being live on the target — delete just that `test.skip` call to harden
// this spec the moment `job-module-lca` flips.

/** Discover the seeded LCA job, open its inventory, expand the transport-module line's legs. */
async function openTransportLegs(page: Page): Promise<{ errors: string[] }> {
  const job = await discoverLcaJob(page.request);
  expect(job, "staging must expose an lca/pcf job (seed J000714)").toBeTruthy();

  const errors = collectPageErrors(page);
  await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load").catch(() => undefined);
  await expectHealthyScreen(page);

  const register = page.locator("#lca-assessment-register");
  test.skip(
    (await register.count()) === 0,
    "job-module-lca not live on the target — harden this spec (remove the skip) as part of the flip PR",
  );

  await register.getByRole("button", { name: /Inventory/ }).first().click();
  await expect(register.locator(".nz-lca-inventory")).toBeVisible();

  const legsToggle = register.getByRole("button", { name: /Transport legs/ }).first();
  await expect(legsToggle, "a transport-legs toggle on the seeded A4 line item").toBeVisible();
  await legsToggle.click();
  await expect(register.locator(".nz-lca-legs")).toBeVisible();

  return { errors };
}

test.describe("Track C — LCA transport legs (slice 3)", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set (public smoke run)");

  test("shows the seeded multi-leg journey in order, with mode and distance source", async ({ page }) => {
    const { errors } = await openTransportLegs(page);
    const legs = page.locator(".nz-lca-legs table.nz-tbl tbody tr");

    await expect(legs).toHaveCount(3);
    await expect(legs.nth(0)).toContainText("Ningbo plant, CN");
    await expect(legs.nth(0)).toContainText("Ningbo port, CN");
    await expect(legs.nth(0)).toContainText("geocoded");
    await expect(legs.nth(1)).toContainText("Felixstowe port, UK");
    await expect(legs.nth(2)).toContainText("Leeds pack site, UK");

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("adds a leg using the staging geocode stub, distance stays editable", async ({ page }) => {
    await openTransportLegs(page);
    const panel = page.locator(".nz-lca-legs");

    await panel.getByRole("button", { name: "+ Add leg" }).click();
    const form = panel.locator(".nz-acc-extra").last();
    await expect(form).toBeVisible();

    await form.locator("label", { hasText: "From" }).locator("input").fill("E2E origin, CN");
    await form.locator("label", { hasText: "To" }).locator("input").fill("E2E destination, UK");
    await form.getByRole("button", { name: "Estimate distance (geocode)" }).click();
    await expect(form.getByText(/geocoded — distance stays editable/)).toBeVisible({ timeout: 15_000 });

    const distanceInput = form.locator("label", { hasText: "Distance (km)" }).locator("input");
    await expect(distanceInput).not.toHaveValue("0");
    await distanceInput.fill("999");

    await form.getByRole("button", { name: "Add leg" }).click();
    await expect(panel.getByText("E2E origin, CN")).toBeVisible({ timeout: 15_000 });
  });

  test("the transport-legs panel passes the axe baseline and holds the column", async ({ page }) => {
    await openTransportLegs(page);
    await scanWithBaseline(page, "lca-transport-legs");
    await expectNoHorizontalOverflow(page, "LCA transport legs");
  });
});
