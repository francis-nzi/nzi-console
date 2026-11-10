import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { clientListSpec, jobListSpec, listQueryToSearchParams, parseListQuery, screenContracts } from "@nzi/contracts";
import type { CrmRedBoxRow } from "@nzi/isolated-backend";
import { deadlineHref, redBoxLink, threadPaths } from "../app/lib/crmControlRoomLinks";

// The personalised Control Room, Phase 1 (BRIEF-crm-control-room-redesign): My work by default, Firm-wide as it was, and the
// filtered lists it links to. The reads themselves are proven against a real database (crmControlRoomReal.test.ts).
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const page = read("../app/page.tsx");

describe("the personalised Control Room (Phase 1)", () => {
  it("opens on My work, read for the signed-in CRM; ?view=firm is today's firm-wide board", () => {
    assert.match(page, /const params=await searchParams;if\(params\.view==="firm"\)return <FirmWide\/>/);
    assert.match(page, /loadScreen<CrmControlRoomView>\("crmControlRoom",NO_CRM,"control-room"\)/);
    assert.match(page, /async function FirmWide\(\)\{const \[clientResult,jobResult\]=await Promise\.all\(\[loadScreen<\{clients:ClientScreenReadModel\[\]\}>\("clients"/, "Firm-wide reads what the Control Room always read");
    assert.match(page, /<ReviewQueueCount\/>/, "and keeps its panels");
  });

  it("the switch is two links, the current one marked, on both views", () => {
    assert.match(page, /<Link href="\/" aria-current=\{view==="mine"\?"page":undefined\}>My work<\/Link><Link href="\/\?view=firm" aria-current=\{view==="firm"\?"page":undefined\}>Firm-wide<\/Link>/);
    assert.match(page, /<ViewSwitch view="firm"\/>/);
    assert.match(page, /<ViewSwitch view="mine"\/>/);
  });

  it("the CRM is the session's principal, never a parameter, and the route only reads", () => {
    const route = read("../app/api/isolated/control-room/route.ts");
    assert.match(route, /const principal = await currentStaff\(request\)/);
    assert.match(route, /withTenantRead\(isolatedPool\(\), principal\.organisationId, \(db\) => readCrmControlRoom\(db, \{ userId: principal\.userId, today: todayInLondon\(\) \}\)\)/);
    assert.doesNotMatch(route, /searchParams|export async function (POST|PUT|PATCH|DELETE)/);
  });

  it("My jobs / My clients open the lists pre-filtered to the CRM, and each recent job links into it", () => {
    assert.match(page, /mine=\(path:string\)=>crm\?`\$\{path\}\?crm=\$\{encodeURIComponent\(crm\.userId\)\}`:path/);
    assert.match(page, /href=\{mine\("\/jobs"\)\}>My jobs →/);
    assert.match(page, /href=\{mine\("\/clients"\)\}>My clients →/);
    assert.match(page, /href=\{`\/jobs\/\$\{encodeURIComponent\(job\.jobId\)\}`\} key=\{job\.jobId\} data-recent-job=\{job\.number\}/);
    // The link the page writes is one the list reads back as the same filter.
    const jobs = parseListQuery(new URLSearchParams("crm=cam"), jobListSpec);
    const clients = parseListQuery(new URLSearchParams("crm=cam"), clientListSpec);
    assert.deepEqual([jobs.issues, clients.issues], [[], []]);
    assert.deepEqual([jobs.query.filters, clients.query.filters], [{ crm: ["cam"] }, { crm: ["cam"] }]);
    assert.equal(listQueryToSearchParams(jobs.query, jobListSpec).toString(), "crm=cam");
    assert.equal(listQueryToSearchParams(clients.query, clientListSpec).toString(), "crm=cam");
  });

  it("the lists say whose work it is and keep the scope when filters are cleared", () => {
    for (const file of ["../app/jobs/JobsIndex.tsx", "../app/clients/ClientsBoard.tsx"]) {
      const source = read(file);
      assert.match(source, /const crm = query\.filters\.crm\?\.\[0\] \?\? null;/);
      assert.match(source, /isSignedIn\(me, crm\) \? "Your (jobs|clients)" : "One client manager’s (jobs|clients)"/);
      assert.match(source, /nav\.clear\(keep\)/);
    }
  });

  it("the cards are quiet counts; a failed read says so, and fixture mode says there is no CRM rather than showing noughts", () => {
    for (const label of ["My live jobs", "Awaiting client", "To validate / issue", "Unread messages", "Reviews due"]) assert.ok(page.includes(`label="${label}"`), label);
    assert.match(page, /data-crm-control-room="failed"/);
    assert.match(page, /data-crm-control-room="no-crm"/);
    assert.match(page, /const NO_CRM:CrmControlRoomView=\{userId:null,cards:null,recentJobs:\[\],redBox:\[\],threads:\[\],deadlines:\[\],pulse:null\}/);
    assert.equal(screenContracts.crmControlRoom.validate(NO_CRM_SHAPE), true);
    assert.equal(screenContracts.crmControlRoom.validate({ cards: {} }), false, "a body without the recent list is refused, not shown as empty");
    assert.equal(screenContracts.crmControlRoom.isEmpty(NO_CRM_SHAPE), false);
  });
});

describe("the personalised Control Room (Phase 2): the Red box, Messages and the thread drawer", () => {
  const drawer = read("../app/CrmThreadDrawer.tsx");
  const row = (fields: Partial<CrmRedBoxRow>) => ({ kind: "unread", threadId: null, clientId: "c 1", jobId: null, ...fields }) as CrmRedBoxRow;

  it("the Needs me now card is the Red box's row count, and the box sits beside the jobs list", () => {
    assert.match(page, /<Metric label="Needs me now" value=\{String\(crm\.cards\.needsMeNow\)\} note="See the Red box"/);
    assert.match(page, /<aside className="nz-control-aside"><RedBox rows=\{crm\.redBox\} day=\{day\}\/><DeadlinesPanel rows=\{crm\.deadlines\} day=\{day\}\/><PulsePanel pulse=\{crm\.pulse\} clientsHref=\{mine\("\/clients"\)\}\/>/);
    assert.match(page, /data-crm-red-box=\{rows\.length\}><div className="nz-redbox-h"><h2 id="crm-red-box">Red box — needs you now<\/h2><b className="num">\{rows\.length\}<\/b>/);
    assert.match(page, /<MessagesPanel threads=\{crm\.threads\} now=\{now\} day=\{day\}\/>/);
  });

  it("each Red box row links to the thing: the job, the conversation's drawer, or the client's SRS", () => {
    assert.deepEqual(redBoxLink(row({ kind: "job-overdue", jobId: "j 1" })), { href: "/jobs/j%201", go: "Open" });
    assert.deepEqual(redBoxLink(row({ kind: "report-answered", jobId: "j1", threadId: "t1" })), { href: "/jobs/j1", go: "Open" }, "a report's thread collapsed into its job opens the job");
    assert.deepEqual(redBoxLink(row({ kind: "awaiting-approval", jobId: "j1" })), { href: "/jobs/j1", go: "Approve" });
    assert.deepEqual(redBoxLink(row({ kind: "unread", threadId: "t 1" })), { href: "/?msg=t%201", go: "Reply" });
    assert.deepEqual(redBoxLink(row({ kind: "srs-review-request", threadId: "t2" })), { href: "/?msg=t2", go: "Reopen" });
    assert.deepEqual(redBoxLink(row({ kind: "srs-review-overdue" })), { href: "/clients/c%201?area=srs", go: "Review" });
    assert.deepEqual(redBoxLink(row({ kind: "srs-review-today" })), { href: "/clients/c%201?area=srs", go: "Review" });
    assert.match(page, /href=\{link\.href\} scroll=\{false\} key=\{row\.subject\} data-red-box-row=\{row\.subject\}/);
    assert.equal(deadlineHref({ kind: "srs-review", clientId: "c1", jobId: null }), "/clients/c1?area=srs");
    assert.equal(deadlineHref({ kind: "action-due", clientId: "c1", jobId: null }), "/clients/c1?area=strategies");
    assert.equal(deadlineHref({ kind: "window-closes", clientId: "c1", jobId: "j1" }), "/jobs/j1");
  });

  it("a message opens its own thread in the drawer, and only one of the CRM's", () => {
    assert.match(page, /href=\{threadHref\(thread\.threadId\)\} scroll=\{false\} key=\{thread\.threadId\} data-crm-thread-row=\{thread\.threadId\}/);
    assert.match(page, /openThread=\{typeof params\.msg==="string"\?params\.msg:null\}/);
    // The drawer is handed the thread from the CRM's own read; a msg that names any other thread opens nothing.
    assert.match(page, /<CrmThreadDrawer key=\{openThread\} thread=\{crm\.threads\.find\(thread=>thread\.threadId===openThread\)\?\?null\}\/>/);
    assert.match(drawer, /\{!thread \? <p className="sub" role="status">This conversation is not one of yours, so it is not opened here\./);
    assert.match(drawer, /if \(!thread \|\| !draft\.trim\(\) \|\| busy\) return;/);
  });

  it("a reply posts through the existing commands to the thread that was opened, then the dashboard is read again", () => {
    assert.deepEqual(threadPaths({ clientId: "c 1", threadId: "t/1", srs: false }), { read: "/api/isolated/clients/c%201/threads/t%2F1", reply: "/api/isolated/clients/c%201/threads/t%2F1" });
    assert.deepEqual(threadPaths({ clientId: "c1", threadId: "t1", srs: true }), { read: "/api/isolated/clients/c1/threads/t1", reply: "/api/isolated/clients/c1/srs-thread" }, "the SRS conversation's reply is srs.message.post");
    assert.match(drawer, /fetch\(threadPaths\(thread\)\.reply, \{\s*method: "POST"/);
    assert.match(drawer, /body: JSON\.stringify\(\{ body: draft\.trim\(\) \}\)/);
    assert.match(drawer, /await load\(\);\s*\/\/ The reply answers the client[^\n]*\n\s*router\.refresh\(\);/);
    // The routes it reaches are the existing ones: client.message.post and srs.message.post, which queue the link-only email.
    assert.match(read("../app/api/isolated/clients/[clientId]/threads/[threadId]/route.ts"), /requireCommandPrincipal\(request, "client\.message\.post"\)/);
    assert.match(read("../app/api/isolated/clients/[clientId]/srs-thread/route.ts"), /requireCommandPrincipal\(request, "srs\.message\.post"\)/);
    assert.match(drawer, /emailed a link only, never the message text, and only if they have agreed to email/);
  });

  it("a review request offers the reopen, in the client's SRS where the existing command is", () => {
    assert.match(drawer, /\{thread\.reviewRequest \? <div className="nz-banner warn" data-crm-review-request>/);
    assert.match(drawer, /href=\{`\/clients\/\$\{encodeURIComponent\(thread\.clientId\)\}\?area=srs`\}>Reopen in SRS →/);
  });

  it("the contract refuses a body without the Phase 2 lists, rather than drawing an empty box", () => {
    assert.equal(screenContracts.crmControlRoom.validate({ ...NO_CRM_SHAPE, redBox: undefined }), false);
    assert.equal(screenContracts.crmControlRoom.validate({ ...NO_CRM_SHAPE, threads: undefined }), false);
  });
});

const NO_CRM_SHAPE = { userId: null, cards: null, recentJobs: [], redBox: [], threads: [], deadlines: [], pulse: null };
