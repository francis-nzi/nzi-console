import { expect, type Page } from "@playwright/test";

// The console renders five explicit states (ARCHITECTURE §6, NZC-006). A healthy
// rendered screen is one that reached "success" or "empty" — never "failed" or
// the degraded banner — with its main landmark present.
export async function expectHealthyScreen(page: Page): Promise<void> {
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator(".nz-screen-state.failed")).toHaveCount(0);
  await expect(page.getByText("Workspace unavailable", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Isolated API unavailable", { exact: false })).toHaveCount(0);
  await expect(page.getByText("The isolated data service is unavailable", { exact: false })).toHaveCount(0);
}

// Known, catalogued client errors on the deployed target that the suite records
// but does not fail on. Keep this list short and tracked — every entry is a bug.
//  - React #418: a pre-existing SSR/CSR hydration text mismatch on the CRP job
//    workspace. Surfaced 30 Aug 2026; PortalHome's instance (time-of-day greeting)
//    was fixed in the same change. TODO: locate and fix the CRP instance.
const KNOWN_PAGE_ERRORS = [/Minified React error #418/];

export function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  const record = (line: string) => {
    if (!KNOWN_PAGE_ERRORS.some((re) => re.test(line))) errors.push(line);
  };
  page.on("pageerror", (error) => record(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") record(`console.error: ${message.text()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 500) record(`${response.status()} ${response.url()}`);
  });
  return errors;
}
