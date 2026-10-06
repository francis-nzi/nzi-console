import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * JW-13 step 1: an Add-entry search on a job with no factors for the category says why — the job has no reporting
 * datasets selected — and where to fix it, instead of an empty list; and the suggestions show as soon as the box has
 * focus. The JW-9 rule (a real factor is required to save) is untouched.
 */
const APP = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "app/jobs");
const read = (file: string) => readFileSync(join(APP, file), "utf8");

describe("JW-13 — the empty activity search explains itself", () => {
  const form = read("EmissionEntryForm.tsx");

  it("names the cause and the fix when the category has no factors, CRM only", () => {
    assert.ok(form.includes('const noFactors = audience === "crm" && factors.length === 0;'), "no factors, in the CRM, is its own state");
    assert.match(form, /No \{category\.name\} factors are available for this job — select its reporting datasets in Setup\./);
    assert.ok(form.includes("onClick={props.onOpenDatasets}") && form.includes('<a href="#job-datasets">'), "it opens the job's datasets — by the workspace's action, else a link");
    assert.ok(read("CrpScopeWorkspace.tsx").includes('onOpenDatasets={() => { setAddingCategory(null); setOpenStages(current => new Set(current).add("Setup"));'), "the workspace opens the Setup stage first — it may be collapsed");
    assert.ok(read("CrpScopeWorkspace.tsx").includes('<section className="nz-panel nz-config-panel" id="job-datasets">'), "which the Datasets panel answers to");
  });

  it("shows the suggestions on focus, not only once something is typed", () => {
    assert.ok(form.includes(") : searchOpen ? ("), "the list opens with the box, typed or not");
    assert.ok(!form.includes("searchOpen && draft.activity.trim() ? ("), "the typed-text gate is gone");
  });

  it("leaves the JW-9 save rule alone — a real factor is still required", () => {
    assert.ok(form.includes("quickAddSaveIssue(draft, factors, category, audience)"));
  });
});
