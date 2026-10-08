import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/** Reporting S-1 (ruled): several published reports per job, one per scope — the routes and the portal page name the one in view. */
describe("published reports per scope (S-1)", () => {
  const staff = read("apps/console/app/api/isolated/jobs/[jobId]/published-report/route.ts");
  const portal = read("apps/console/app/api/portal/jobs/[jobId]/published-report/route.ts");
  const page = read("apps/console/app/portal/jobs/[jobId]/page.tsx");
  const print = read("apps/console/app/portal/jobs/[jobId]/print/page.tsx");
  const register = read("apps/console/app/reports/LiveReportRegister.tsx");

  it("serves the report asked for, else the default, and lists every published scope — on both routes", () => {
    for (const route of [staff, portal]) {
      assert.match(route, /searchParams\.get\("reportVersionId"\)/);
      assert.match(route, /wanted\?reports\.find\(item=>item\.reportVersionId===wanted\)\?\?null:reports\[0\]\?\?null/, "the default is the first: whole-client, then the most recent");
      assert.match(route, /reports:reports\.map\(item=>\(\{reportVersionId:item\.reportVersionId,scope:item\.scope,scopeLabel:item\.scopeLabel,publishedAt:item\.publishedAt\}\)\)/);
    }
    assert.match(portal, /listGrantedPublishedCrpReports/, "portal v1: a grant sees every scope of its job");
  });

  it("lets the portal reader switch scope, with the scope carried through to print", () => {
    assert.match(page, /body\.reports&&body\.reports\.length>1\?<ScopeSwitcher/);
    assert.match(page, /aria-current=\{entry\.reportVersionId===current\?"page":undefined\}/);
    for (const surface of [page, print]) assert.match(surface, /\/published-report\$\{query\}/);
  });

  it("names each version's scope in the register", () => {
    assert.match(register, /report\.scopeLabel \? <div className="muted">\{report\.scopeLabel\}<\/div> : null/);
  });
});
