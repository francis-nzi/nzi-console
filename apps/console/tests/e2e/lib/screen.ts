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

export function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`);
  });
  return errors;
}
