import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultShellJob, shellNav, switchJobPath, type ShellJob } from "../app/portal/shell/shellNav";
import { previewLink } from "../app/portal/portalPreviewLinks";

/**
 * BUILD-portal-shell-lookandfeel: MOCKUP-client-portal.html's left-rail shell as the portal chrome, in the client portal and the
 * staff preview. What the rail offers, where it goes, which job it opens on, and that it stays dark and read-only in preview.
 */
(globalThis as { React?: unknown }).React = React;
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const job = (id: string, published: boolean, year = 2025): ShellJob => ({ id, number: `J000${id}`, title: "CRP", reportingYear: year, hasPublishedReport: published });
const all = () => true;

describe("the portal shell", () => {
  describe("the rail (pure)", () => {
    it("offers the wired views, each behind the client's own flag, for the job in context", () => {
      assert.deepEqual(shellNav("663", (path) => path, all).map((item) => [item.view, item.href]), [
        ["dashboard", "/portal/jobs/663/dashboard"], ["data", "/portal/jobs/663/data"], ["reports", "/portal/reports"]]);
      assert.deepEqual(shellNav("663", (path) => path, (flag) => flag !== "portal-data").map((item) => item.view), ["dashboard", "reports"], "a flag off for clients is off in the rail");
      assert.deepEqual(shellNav(null, (path) => path, all).map((item) => item.view), ["reports"], "a per-job view needs a job");
    });

    it("in the staff preview, every item goes to the preview's own page — never into the portal", () => {
      const items = shellNav("663", (path) => previewLink("c1", path), all);
      assert.deepEqual(items.map((item) => item.href), ["/clients/c1/portal-preview/jobs/663/dashboard", "/clients/c1/portal-preview/jobs/663/data", "/clients/c1/portal-preview/reports"]);
    });

    it("opens on the newest job with a published report, else the newest job; the switcher keeps the per-job view", () => {
      assert.equal(defaultShellJob([job("700", false, 2026), job("663", true), job("612", true, 2024)])?.id, "663");
      assert.equal(defaultShellJob([job("700", false)])?.id, "700");
      assert.equal(defaultShellJob([]), null);
      assert.equal(switchJobPath("data", "612"), "/portal/jobs/612/data");
      assert.equal(switchJobPath("reports", "612"), "/portal/jobs/612/dashboard");
    });
  });

  describe("the frame", () => {
    const render = async (preview: boolean) => {
      // The rail is flag-gated as the client's pages are; these renders draw the views that are on.
      process.env.NEXT_PUBLIC_FEATURE_PORTAL = "portal-analytics,portal-data,portal-reports";
      const { PortalShell } = await import("../app/portal/shell/PortalShell");
      const { PreviewSurfaceProvider } = await import("../app/portal/portalSurface");
      const shell = createElement(PortalShell, { client: { name: "EFF Group", logoSrc: null }, jobs: [job("663", true), job("612", true, 2024)], jobId: "663", view: "dashboard",
        person: preview ? { kind: "preview" } : { kind: "client", name: "Pat Client", detail: "pat@example.invalid", onSignOut: () => undefined }, children: createElement("p", null, "the view") });
      return renderToStaticMarkup(preview ? createElement(PreviewSurfaceProvider, { clientId: "c1", children: shell }) : shell);
    };

    it("draws the mockup's rail around the view: brand, client, job switcher, groups, the current item, who is signed in", async () => {
      const html = await render(false);
      for (const needle of ["NZ Insights Pro", "EFF Group", "Reporting job", ">Workspace<", "<p>the view</p>", "Pat Client", ">Sign out<", "href=\"/portal/account\""]) assert.ok(html.includes(needle), needle);
      assert.match(html, /<a class="nzp-navitem" href="\/portal\/jobs\/663\/dashboard" aria-current="page">/);
      assert.match(html, /EFF Group<span class="sep" aria-hidden="true">›<\/span>J000663<span class="sep" aria-hidden="true">›<\/span><b>Dashboard<\/b>/);
    });

    it("in preview: says so, and offers no sign-out, no account and no link into the portal", async () => {
      const html = await render(true);
      assert.match(html, /● Staff preview/);
      assert.doesNotMatch(html, /Sign out|Security|href="\/portal/);
      assert.match(html, /class="nzp-app nzp-preview"/);
    });
  });

  describe("dark by absence, and scoped", () => {
    it("the token is declared in portalFlags.ts and nowhere in render.yaml (#503/#505)", () => {
      assert.match(read("apps/console/app/lib/portalFlags.ts"), /\| "portal-shell";/);
      assert.doesNotMatch(read("render.yaml"), /portal-shell/);
    });

    it("off, the portal is as before: the old home, the dashboard page's own frame, the preview's own nav", () => {
      assert.match(read("apps/console/app/portal/page.tsx"), /portalFeatureEnabled\("portal-shell"\)&&portalFeatureEnabled\("portal-analytics"\)\?<ShellDashboard[^:]*:<PortalHome\/>/);
      assert.match(read("apps/console/app/portal/jobs/[jobId]/dashboard/page.tsx"), /if \(portalFeatureEnabled\("portal-shell"\)\) return <ShellDashboard/);
      assert.match(read("apps/console/app/clients/[clientId]/portal-preview/PreviewFrame.tsx"), /<PreviewBar preview=\{preview\} surface=\{surface\} nav=\{!shell\} \/>/);
    });

    it("on, the critical views are framed in the shell: Data, Reports and the job's report (increment 1)", () => {
      assert.match(read("apps/console/app/portal/jobs/[jobId]/data/page.tsx"), /if \(portalFeatureEnabled\("portal-shell"\)\) return <PortalShellClient view="data" jobId=\{jobId\}><PortalDataView jobId=\{jobId\} \/><\/PortalShellClient>;/);
      assert.match(read("apps/console/app/portal/reports/page.tsx"), /if \(portalFeatureEnabled\("portal-shell"\)\) return <PortalShellClient view="reports"><PortalReports \/><\/PortalShellClient>;/);
      assert.match(read("apps/console/app/portal/jobs/[jobId]/page.tsx"), /portalFeatureEnabled\("portal-shell"\)\?<PortalShellClient view="reports" jobId=\{jobId\}>\{page\}<\/PortalShellClient>:page/);
      // The preview frames every surface it opens.
      assert.match(read("apps/console/app/clients/[clientId]/portal-preview/PreviewFrame.tsx"), /\{shell \? \(/);
    });

    it("the mockup's tokens are namespaced and scoped to the shell, so they cannot restyle the views inside it", () => {
      const css = read("apps/console/app/portal/shell/portal-shell.css");
      assert.doesNotMatch(css, /:root/);
      assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /--(bg|card|line|ink|muted|panel|rail)\s*:/, "every token is --nzp-*");
      assert.match(css, /\.nzp-app\{\s*--nzp-bg:#eef1f5;/);
    });
  });
});
