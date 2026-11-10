import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { clientListSpec, jobListSpec, listQueryToSearchParams, parseListQuery, screenContracts } from "@nzi/contracts";

// The personalised Control Room, Phase 1 (BRIEF-crm-control-room-redesign): My work by default, Firm-wide as it was, and the
// filtered lists it links to. The reads themselves are proven against a real database (crmControlRoomReal.test.ts).
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const page = read("../app/page.tsx");

describe("the personalised Control Room (Phase 1)", () => {
  it("opens on My work, read for the signed-in CRM; ?view=firm is today's firm-wide board", () => {
    assert.match(page, /if\(\(await searchParams\)\.view==="firm"\)return <FirmWide\/>/);
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
    assert.match(page, /const NO_CRM:CrmControlRoomView=\{userId:null,cards:null,recentJobs:\[\]\}/);
    assert.equal(screenContracts.crmControlRoom.validate(NO_CRM_SHAPE), true);
    assert.equal(screenContracts.crmControlRoom.validate({ cards: {} }), false, "a body without the recent list is refused, not shown as empty");
    assert.equal(screenContracts.crmControlRoom.isEmpty(NO_CRM_SHAPE), false);
  });
});

const NO_CRM_SHAPE = { userId: null, cards: null, recentJobs: [] };
