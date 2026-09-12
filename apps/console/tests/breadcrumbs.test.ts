import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { clientCrumbs, clientJobsHref, jobCrumbs, workspaceCrumbs } from "../app/lib/crumbs";

// Resolved from this file, so the suite passes from the repo root and from the package.
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/**
 * The trail matches the live hierarchy — a job belongs to a client, so the client is in
 * the trail — and every crumb is a real link, including the current page.
 */
describe("breadcrumbs", () => {
  const job = { id: "job-712", number: "J000712", clientId: "client-a", client: "Northwind Manufacturing" };

  it("puts the client in a job sub-area trail, in the live order", () => {
    assert.deepEqual(jobCrumbs(job, { label: "Scope rows" }), [
      { label: "Clients", href: "/clients" },
      { label: "Northwind Manufacturing", href: "/clients/client-a" },
      { label: "Jobs", href: "/jobs?client=client-a" },
      { label: "J000712", href: "/jobs/job-712", current: false },
      { label: "Scope rows", href: "/jobs/job-712", current: true },
    ]);
  });

  it("ends at the job number on a job workspace, and marks it current", () => {
    const trail = jobCrumbs(job);
    assert.deepEqual(trail.map((crumb) => crumb.label), ["Clients", "Northwind Manufacturing", "Jobs", "J000712"]);
    assert.equal(trail.at(-1)?.current, true);
  });

  it("keeps in-client areas out of the client trail — they live on the sub-nav", () => {
    assert.deepEqual(clientCrumbs({ id: "client-a", name: "Northwind Manufacturing" }), [
      { label: "Clients", href: "/clients" },
      { label: "Northwind Manufacturing", href: "/clients/client-a", current: true },
    ]);
  });

  it("escapes ids so a crumb cannot be broken by the data", () => {
    assert.equal(clientJobsHref("client a/b"), "/jobs?client=client%20a%2Fb");
    assert.equal(jobCrumbs({ ...job, id: "job/712", clientId: "c d" })[1]!.href, "/clients/c%20d");
  });

  it("two jobs carry their own client and number", () => {
    const other = jobCrumbs({ id: "job-9", number: "J000900", clientId: "client-b", client: "Harbour Foods" });
    assert.deepEqual(other.map((crumb) => crumb.label), ["Clients", "Harbour Foods", "Jobs", "J000900"]);
    assert.notDeepEqual(other, jobCrumbs(job));
  });

  it("a board crumb is still a link to itself", () => {
    assert.deepEqual(workspaceCrumbs("Clients", "/clients"), [{ label: "Clients", href: "/clients", current: true }]);
    assert.deepEqual(workspaceCrumbs("Emissions", "/charts", { label: "Chart library", href: "/charts" }), [
      { label: "Emissions", href: "/charts" },
      { label: "Chart library", href: "/charts", current: true },
    ]);
  });

  it("every crumb in every trail has a route — none is plain text", () => {
    const trails = [
      jobCrumbs(job), jobCrumbs(job, { label: "Scope rows" }),
      clientCrumbs({ id: "client-a", name: "Northwind Manufacturing" }),
      workspaceCrumbs("Jobs", "/jobs"),
    ];
    for (const trail of trails) {
      for (const crumb of trail) assert.match(crumb.href, /^\//, `${crumb.label} resolves to a route`);
      assert.equal(trail.filter((crumb) => crumb.current).length, 1, "exactly one crumb is the current page");
    }
  });

  it("no page assembles its own crumb markup any more", () => {
    for (const file of [
      "apps/console/app/jobs/CrpScopeWorkspace.tsx", "apps/console/app/jobs/FamilyWorkspace.tsx",
      "apps/console/app/jobs/lca/LcaWorkspace.tsx", "apps/console/app/jobs/JobsIndex.tsx",
      "apps/console/app/clients/[clientId]/ClientWorkspaceView.tsx", "apps/console/app/clients/ClientsBoard.tsx",
      "apps/console/app/clients/new/ClientCreateWizard.tsx", "apps/console/app/page.tsx",
      "apps/console/app/charts/page.tsx", "apps/console/app/reports/page.tsx",
      "apps/console/app/datasets/DatasetBoard.tsx", "apps/console/app/sales/SalesBoard.tsx",
      "apps/console/app/lca/LcaBoard.tsx", "apps/console/app/platform/PlatformBoard.tsx",
    ]) {
      const source = read(file);
      assert.match(source, /crumbs=\{crumbTrail\(/, `${file} builds its crumbs with the shared builder`);
      assert.doesNotMatch(source, /crumbs=\{<>/, `${file} still has inline crumb markup`);
    }
  });

  it("the client's jobs crumb resolves to a route that filters to that client", () => {
    const index = read("apps/console/app/jobs/JobsIndex.tsx");
    assert.match(index, /clientId/, "the jobs index accepts the client scope");
    assert.match(index, /allJobs\.filter\(\(job\) => job\.header\.clientId === scopedClient\.id\)/);
    assert.match(read("apps/console/app/jobs/page.tsx"), /searchParams/, "the route reads ?client=");
  });
});
