import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { seedOutcomeText } from "../app/jobs/jobTemplateSeedingText";

/**
 * Phase 3b: the capture surface offers the client's reporting template (seed, or fill the gaps) where JW-6's "Add rows
 * from template" search and "Reuse Previous Year Rows" used to be — retired, because the rows come from the template.
 */
const APP = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "app");
const result = (over: Partial<Parameters<typeof seedOutcomeText>[0]> = {}) => ({ jobId: "j", templateVersion: 3, seeded: 9, skipped: {}, siteDropped: 0, ...over });

describe("template seeding on the capture surface (Phase 3b)", () => {
  it("says what a seed did in counts, naming each reason a line was skipped", () => {
    assert.equal(seedOutcomeText(result()), "Seeded 9 entries from template v3.");
    assert.equal(seedOutcomeText(result({ seeded: 1 })), "Seeded 1 entry from template v3.");
    assert.equal(seedOutcomeText(result({ skipped: { toFile: 2, duplicate: 1, FACTOR_REQUIRED: 1 }, siteDropped: 2 })),
      "Seeded 9 entries from template v3 — skipped 2 not yet filed under a category, 1 already on the job, 1 with no factor in this job's datasets; 2 seeded without a site (archived or left out of this job).");
    assert.equal(seedOutcomeText(result({ seeded: 0, skipped: { duplicate: 5 } })), "Seeded 0 entries from template v3 — skipped 5 already on the job.");
    assert.match(seedOutcomeText(result({ skipped: { SOMETHING_NEW: 1 } })), /1 refused \(SOMETHING_NEW\)/, "an unnamed refusal is shown as itself, not hidden");
  });

  it("replaces JW-6's two blocks with the template control, in the same place", () => {
    const accordion = readFileSync(join(APP, "jobs/CrpDataEntryAccordion.tsx"), "utf8");
    assert.match(accordion, /<JobTemplateSeeding jobId=\{jobId\} notice=\{notice\} \/>/);
    assert.doesNotMatch(accordion, /TemplateSearchBar|ReuseYearPanel|libraryFactors|id="fast-add"/);
    for (const retired of ["jobs/TemplateSearchBar.tsx", "jobs/ReuseYearPanel.tsx"]) assert.ok(!existsSync(join(APP, retired)), `${retired} is retired`);
    // The fuzzy match stays: the LCA inventory's quick-add ranks with it.
    assert.match(readFileSync(join(APP, "jobs/lca/LcaWorkspace.tsx"), "utf8"), /import \{ fuzzyScore \} from "\.\.\/templateSearch";/);
  });

  it("seeds the version it was shown, and never reads a failed status as 'no template'", () => {
    const control = readFileSync(join(APP, "jobs/JobTemplateSeeding.tsx"), "utf8");
    assert.match(control, /postBrowserCommand<TemplateSeedResult>\(path, \{ expectedTemplateVersion: version \}/);
    assert.match(control, /The reporting template could not be read\./);
  });
});
