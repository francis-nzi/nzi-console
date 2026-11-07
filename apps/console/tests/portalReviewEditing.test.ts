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

// Client-review loop S5: the Approve button and the message panel on the same page, behind the same flag.
import { APPROVE_NOTE, approveBlockedReason, messageToSend } from "../app/portal/jobs/[jobId]/review/reviewEditing";

describe("the portal review page: messaging and Approve (S5)", () => {
  it("Approve says what it does before it is sent, and waits for changes not yet sent (it is pinned to the version on screen)", () => {
    assert.equal(APPROVE_NOTE, "This issues your sign-off to the team; the report is then locked for your edits.");
    assert.equal(approveBlockedReason(0), null);
    assert.match(approveBlockedReason(2)!, /Press Update/);
  });
  it("a message is trimmed and bounded the way the command bounds it", () => {
    assert.equal(messageToSend("  hello  "), "hello");
    assert.equal(messageToSend("   "), null);
    assert.equal(messageToSend("x".repeat(4000)), "x".repeat(4000));
    assert.equal(messageToSend("x".repeat(4001)), null);
  });
  it("the new routes are flag-gated, same-origin, portal-principal-only and run exactly the one command each", () => {
    const routes: Array<[string, string]> = [["approve", "approveReportAsClient"], ["message", "postReportMessageAsClient"]];
    for (const [name, fn] of routes) {
      const route = read(`../app/api/portal/jobs/[jobId]/review-report/${name}/route.ts`);
      assert.match(route, /portalFeatureEnabled\("portal-report-review"\)/, name);
      assert.match(route, /requirePortalOrigin\(request\)/, name);
      assert.ok(route.includes(`${fn}(isolatedPool(), body, portalCommandContext(request, user))`), name);
      assert.doesNotMatch(route, /requireCommandPrincipal|currentStaff/, `${name}: never a staff principal`);
      assert.doesNotMatch(route, /export async function (GET|PUT|PATCH|DELETE)/, name);
    }
  });
  it("the page has one Approve (behind a confirm note) and a message box, and approving locks the editing controls", () => {
    const view = read("../app/portal/jobs/[jobId]/review/PortalReviewReport.tsx");
    assert.equal((view.match(/data-portal-review-approve-confirm/g) ?? []).length, 1);
    assert.match(view, /APPROVE_NOTE/);
    assert.match(view, /review-report\/approve/);
    assert.match(view, /expectedVersion: round\.version/, "pinned to the version on screen");
    assert.match(view, /disabled=\{busy \|\| pending\.length > 0 \|\| confirming\}/, "unsent changes block Approve");
    assert.match(view, /open \? <div className="nzs-toolbar"/, "the toolbar (Update, Approve) only on an open round");
    assert.match(view, /review-report\/message/);
    assert.doesNotMatch(view, /dangerouslySetInnerHTML=\{\{ __html: entry\.body/, "a message is plain text, never HTML");
  });
});
