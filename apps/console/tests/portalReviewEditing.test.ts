import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { editsToSend, savedMessage } from "../app/portal/jobs/[jobId]/review/reviewEditing";

// Client-review loop S4: the portal review page's pure parts, and the wiring that keeps it dark and read-only where it must be.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("the portal review page (S4)", () => {
  const held = [{ key: "executive-summary", bodyHtml: "<p>a</p>" }, { key: "background", bodyHtml: "<p>b</p>" }];
  it("sends only the drafts that differ from what the round holds, trimmed, and only for sections it holds", () => {
    assert.deepEqual(editsToSend({ "executive-summary": "<p>a</p>", background: " <p>b2</p> ", "not-held": "<p>x</p>" }, held), [{ sectionKey: "background", bodyHtml: "<p>b2</p>" }]);
    assert.deepEqual(editsToSend({}, held), []);
  });
  it("confirms what was saved, by title, or says nothing changed", () => {
    const title = (key: string) => ({ a: "Executive summary", b: "Background", c: "Reduction actions" })[key] ?? key;
    assert.equal(savedMessage(["a"], title), "Saved your changes to Executive summary. The team can see what changed.");
    assert.equal(savedMessage(["a", "b", "c"], title), "Saved your changes to Executive summary, Background and Reduction actions. The team can see what changed.");
    assert.equal(savedMessage([], title), "Nothing had changed, so nothing was saved.");
  });
  it("is dark until the flag is on: the page, the read and the write route all check portal-report-review", () => {
    assert.match(read("../app/lib/portalFlags.ts"), /\| "portal-report-review"/);
    assert.doesNotMatch(read("../../../render.yaml"), /portal-report-review/, "dark by absence: not in render.yaml");
    for (const file of ["../app/portal/jobs/[jobId]/review/page.tsx", "../app/api/portal/jobs/[jobId]/review-report/route.ts", "../app/api/portal/jobs/[jobId]/review-report/update/route.ts", "../app/portal/jobs/[jobId]/page.tsx"]) {
      assert.match(read(file), /portalFeatureEnabled\("portal-report-review"\)/, file);
    }
  });
  it("the write route runs only the portal command, as the portal user, behind the portal origin check; the read route is GET only", () => {
    const write = read("../app/api/portal/jobs/[jobId]/review-report/update/route.ts");
    assert.match(write, /requirePortalOrigin\(request\)/);
    assert.match(write, /updateReportAsClient\(isolatedPool\(\), body, portalCommandContext\(request, user\)\)/);
    assert.doesNotMatch(write, /requireCommandPrincipal|currentStaff/, "never a staff principal");
    const get = read("../app/api/portal/jobs/[jobId]/review-report/route.ts");
    assert.match(get, /export async function GET/);
    assert.doesNotMatch(get, /export async function (POST|PUT|PATCH|DELETE)/);
    assert.match(get, /withTenantRead/);
  });
  it("makes only the narrative editable: the editor is handed to the narrative render-prop, not to figures, charts or tables", () => {
    const view = read("../app/portal/jobs/[jobId]/review/PortalReviewReport.tsx");
    assert.match(view, /narrativeEditor: editor/);
    assert.match(view, /round\.editableSections\.includes\(element\.key\)/);
    assert.match(view, /open && round\.editableSections\.length > 0/, "a locked (approved) round gets no editor");
    assert.match(view, /reportNarrativeBodyIssues\(html\)/, "the browser checks the same rule first; the server holds it again");
    assert.match(view, /data-portal-review-update/, "one Update button");
    assert.equal((view.match(/data-portal-review-update/g) ?? []).length, 1);
  });
});
