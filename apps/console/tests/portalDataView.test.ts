import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { emissionCategoryTaxonomy, PORTAL_PROFILE_DEFAULT, PORTAL_STAFF_ONLY_FIELDS, offeredPortalProfile, resolvePortalProfile, type ApplicableCategory, type InputSpecCategory, type PortalOfferedProfile } from "@nzi/contracts";
import type { PortalDataView, PortalScopeRow } from "@nzi/isolated-backend";
import { historyEntry, isPortalDataView, mayDeactivate, portalScopeRowFields, reviewLabel, rowDrawerSections, windowOpen } from "../app/portal/data/portalDataView";
import { emissionEntryDraftToScopeRow } from "../app/jobs/emissionEntryModel";

/**
 * Portal data-entry phase 2 — the client's Data view (BUILD-portal-dataentry-phase2 §3, §4, §6). It reuses the CRM's own
 * capture components, narrowed by the client's profile; every write goes to a portal command; History is its own container
 * in both drawers; the old records path stops taking writes only once the view is on. The commands and gates themselves are
 * `portalCaptureReal`.
 */
(globalThis as { React?: unknown }).React = React;
// Components are loaded after React is global (a module draws JSX as it loads), as the portal report tests load theirs.
const components = async () => ({
  ...(await import("../app/jobs/CrpDataEntryAccordion")), ...(await import("../app/jobs/EmissionEntryForm")),
  ...(await import("../app/jobs/RowHistory")), ...(await import("../app/portal/jobs/[jobId]/data/PortalDataView")),
});
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const seed = JSON.parse(read("apps/console/tests/fixtures/inputSpec.seed.json")) as InputSpecCategory[];
const gasSpec = seed.find((category) => category.categoryCode === "1.natural-gas")!;
const gas = { ...emissionCategoryTaxonomy.find((category) => category.code === "1.natural-gas")!, entryCount: 1, tco2e: 0.18, completeness: 0, noData: false } as ApplicableCategory;
const profile = (decisions: Array<{ profileKey: string; value: string }> = []): PortalOfferedProfile => offeredPortalProfile(resolvePortalProfile(decisions));
const row = (over: Partial<PortalScopeRow> = {}): PortalScopeRow => ({
  id: "r1", jobId: "job-1", scope: "1", categoryCode: "1.natural-gas", sourceLabel: "Boiler gas", reportLabel: "Boiler gas", categoryPath: ["Scope 1", "Gas"],
  quantity: 1000, unit: "kWh", datasetId: "ds", factorId: "gas-demo", factorVersion: "v1", factorLabel: "Natural gas", qualityTier: null,
  calculatedTco2e: null, overrideTco2e: null, overrideReason: null, reviewStatus: "pending", version: 1, enabled: true, siteId: null, siteLabel: null,
  monthlyActivity: [], provenance: { capturedAs: "client-portal", capturedAt: "2026-10-22T09:00:00.000Z" }, lineage: [{ title: "Entered by the client", detail: "In the client portal · pending staff review" }],
  editable: true, origin: "live", ...over,
} as PortalScopeRow);
const view = (over: Partial<PortalDataView> = {}): PortalDataView => ({
  profile: profile(), access: { jobId: "job-1", startsAt: "2026-10-01T00:00:00Z", expiresAt: "2026-12-31T00:00:00Z", state: "open", reportingMonths: [] },
  categories: { audience: "portal", includedScopes: ["1"], categories: [gas] }, rows: [row()], factors: [], sites: [{ id: "s1", name: "Head Office" }],
  purchasedGoodsCategories: [], reportingMonths: ["2026-01", "2026-02"],
  qa: { total: 1, enabled: 1, approved: 0, pending: 1, rejected: 0, calculationMissing: 1, qualityMissing: 1, independentReviewPending: 1, migratedRows: 0, readyForReporting: false },
  emissions: { jobId: "job-1", siteId: null, headline: { tco2e: 0.18, marketTco2e: 0, entries: 1, marketEntries: 0 }, byScope: [{ scope: "1", tco2e: 0.18, marketTco2e: 0, entries: 1, marketEntries: 0 }], byCategory: [], bySite: [] },
  ...over,
} as PortalDataView);

describe("the client's Data view (portal data-entry phase 2)", () => {
  describe("what it derives", () => {
    it("the route's answer is verified before anything is drawn; entry is open only inside the window", () => {
      assert.equal(isPortalDataView(view()), true);
      assert.equal(isPortalDataView({ ...view(), rows: "x" }), false);
      assert.equal(isPortalDataView({ ...view(), profile: {} }), false);
      assert.equal(windowOpen(view()), true);
      assert.equal(windowOpen(view({ access: null })), false);
      assert.equal(windowOpen(view({ access: { ...view().access!, state: "scheduled" } })), false);
    });

    it("the client's write is the CRM's own mapping less every staff-only field — the form's default quality tier is never sent", () => {
      const fields = emissionEntryDraftToScopeRow({ activity: "Boiler gas", quantity: "1000", unit: "kWh", vatPercent: "", glCode: "", spendCategoryId: "", registration: "",
        usageTypeId: "", manualMode: false, manualDetail: "", factorId: "gas-demo", qualityTier: "Measured", dataConfidence: "M — Medium", supplySource: "",
        factorOverrideReason: "", note: "", monthlyOpen: false, monthly: {} }, gas, { id: null, label: null }, [{ id: "gas-demo", factorId: "gas-demo", label: "Natural gas", unit: "kWh", scope: "1", datasetId: "ds" } as never], []);
      assert.ok(fields.qualityTier, "the shared mapping does default one");
      const sent = portalScopeRowFields(fields) as Record<string, unknown>;
      for (const field of PORTAL_STAFF_ONLY_FIELDS) assert.ok(!(field in sent), field);
      assert.equal(sent.factorId, "gas-demo");
      assert.equal(sent.categoryCode, "1.natural-gas");
    });

    it("the drawer's sections follow the profile: site and months always, the four only with the detailed drawer and each its own toggle, History always", () => {
      assert.deepEqual(rowDrawerSections(profile()), ["site", "monthly", "history"], "the default: the simple drawer");
      assert.deepEqual(rowDrawerSections(profile([{ profileKey: "evidenceProvenance", value: "visible" }])), ["site", "monthly", "history"], "a section needs the detailed drawer");
      assert.deepEqual(rowDrawerSections(profile([{ profileKey: "entryDrawer", value: "detailed" }, { profileKey: "dataQuality", value: "visible" }, { profileKey: "sourceDetail", value: "visible" }])),
        ["site", "monthly", "dataQuality", "sourceDetail", "history"]);
      assert.ok(rowDrawerSections(offeredPortalProfile(PORTAL_PROFILE_DEFAULT)).includes("history"), "History is never a setting");
    });

    it("Deactivate only where the profile offers it, on an entry the client may change, while the window is open", () => {
      const on = profile([{ profileKey: "deactivate", value: "enabled" }]);
      assert.equal(mayDeactivate(profile(), row(), true), false, "off by default");
      assert.equal(mayDeactivate(on, row(), true), true);
      assert.equal(mayDeactivate(on, row({ editable: false }), true), false);
      assert.equal(mayDeactivate(on, row(), false), false);
    });

    it("says review states and History in the client's words — by you or your adviser, never a name", () => {
      assert.equal(reviewLabel(row()), "Waiting for review");
      assert.equal(reviewLabel(row({ reviewStatus: "approved" })), "Reviewed");
      assert.equal(reviewLabel(row({ enabled: false })), "Deactivated");
      assert.deepEqual(historyEntry({ at: "2026-10-22T09:00:00Z", who: "you", action: "portal_scope_row_created" }, 0, "Your NZI adviser"), { id: "2026-10-22T09:00:00Z-0", at: "2026-10-22T09:00:00Z", action: "Entered", by: "You" });
      assert.equal(historyEntry({ at: "x", who: "adviser", action: "scope_row_reviewed" }, 1, "Your NZI adviser").by, "Your NZI adviser");
    });
  });

  describe("the components it reuses", () => {
    it("the CRM accordion, given the client's categories: drawn at once, no template seeding, no staff taxonomy note, Add only while open", async () => {
      const { CrpDataEntryAccordion } = await components();
      const render = (canAdd: boolean) => renderToStaticMarkup(createElement(CrpDataEntryAccordion, {
        audience: "portal", applicable: view().categories, canAdd, specs: { "1.natural-gas": gasSpec }, jobId: "job-1", rows: [row()] as never, selectedRowId: "",
        onOpenRow: () => undefined, onAddEntry: () => undefined, sites: [], siteId: "", factors: [], reportingMonths: [], purchasedGoodsCategories: [], notice: () => undefined,
      }));
      const html = render(true);
      assert.match(html, /Natural Gas/);
      assert.doesNotMatch(html, /Loading the category view/, "no fetch of the staff route");
      assert.doesNotMatch(html, /GHG taxonomy|NZC-045/);
      // Staff's work queue (calculate, quality tier, approve) is not the client's: no lens, no "to do" chips (found in the render).
      assert.doesNotMatch(html, /Needs attention|to do</);
      // Categories render collapsed, so the button is pinned in source as well as by render: the accordion gates it on `canAdd`,
      // and the Data view passes the window's state (mutation-found: a render alone could not tell).
      assert.doesNotMatch(render(false), /\+ Add entry/);
      assert.match(read("apps/console/app/jobs/CrpDataEntryAccordion.tsx"), /\{canAdd \? <button type="button" className="nz-btn pri"\n\s*onClick=\{\(\) => onAddEntry\(entry\.category\)\}>/);
      const dataView = read("apps/console/app/portal/jobs/[jobId]/data/PortalDataView.tsx");
      assert.match(dataView, /const open = windowOpen\(view\);/);
      assert.match(dataView, /audience="portal" applicable=\{view\.categories\} canAdd=\{open && !surface\.readOnly\}/);
      assert.match(read("apps/console/app/jobs/CrpDataEntryAccordion.tsx"), /\{audience === "crm" \? <JobTemplateSeeding/);
    });

    it("the entry form in the portal: the factor pick (0177), never a client factor, one save that goes for review", async () => {
      const { EmissionEntryForm } = await components();
      const html = renderToStaticMarkup(createElement(EmissionEntryForm, { spec: gasSpec, category: gas, audience: "portal", portalDirect: true, site: { id: null, label: "No particular site" },
        factors: [{ id: "gas-demo", label: "Natural gas", unit: "kWh" }], units: ["kWh"], reportingMonths: [], onSubmit: () => undefined, onCancel: () => undefined }));
      assert.match(html, /Emission factor/, "the client picks the factor");
      assert.match(html, /Set to this category(?:&#x27;|')s usual factor/);
      assert.doesNotMatch(html, /Client factor \(EPD\)/);
      assert.match(html, />Save for review</);
      assert.doesNotMatch(html, /Save draft|Submit for review/);
      assert.doesNotMatch(html, /Quality tier|Data confidence/);
    });

    it("the client's row drawer: the always-shown sections, the profile's own, the form for their pending entry, History always — no staff identity", async () => {
      const { PortalRowDrawer } = await components();
      const render = (offered: PortalOfferedProfile, entry = row()) => renderToStaticMarkup(createElement(PortalRowDrawer, {
        jobId: "job-1", row: entry, view: view({ profile: offered }), specs: { "1.natural-gas": gasSpec }, refs: [], open: true, adviser: "Your NZI adviser", onSaved: async () => undefined }));
      const simple = render(profile());
      assert.match(simple, /aria-label="Site"/);
      assert.match(simple, /aria-label="Monthly activity"/);
      assert.match(simple, /History/);
      assert.match(simple, /data-row-history/);
      for (const hidden of ["Factor &amp; calculation", "Data quality", "Evidence &amp; provenance"]) assert.ok(!simple.includes(`aria-label="${hidden}"`), hidden);
      assert.doesNotMatch(simple, />[^<]*hidden[^<]*</i, "a hidden section is absent, never a placeholder (visible text only; aria-hidden is markup)");
      assert.match(simple, /Change this entry/);
      const detailed = render(profile([{ profileKey: "entryDrawer", value: "detailed" }, { profileKey: "evidenceProvenance", value: "visible" }]));
      assert.match(detailed, /aria-label="Evidence &amp; provenance"/);
      assert.match(detailed, /Entered by the client/);
      const theirs = render(profile(), row({ editable: false, provenance: { capturedAs: "staff" } }));
      assert.doesNotMatch(theirs, /Change this entry/);
      assert.match(theirs, /can(?:&#x27;|')t be changed here/);
      assert.doesNotMatch(theirs, />Deactivate</, "Deactivate is off by default");
    });

    it("the client's edit form opens on the factor the entry has — found by the factor, not by the form's option key (found in the render)", async () => {
      const { PortalRowDrawer } = await components();
      const refs = [
        { id: "ds:diesel", factorId: "diesel", datasetId: "ds", label: "Diesel", unit: "litres", scope: "1" },
        { id: "ds:gas-demo", factorId: "gas-demo", datasetId: "ds", label: "Natural gas", unit: "kWh", scope: "1" },
      ];
      const html = renderToStaticMarkup(createElement(PortalRowDrawer, { jobId: "job-1", row: row(), view: view(), specs: { "1.natural-gas": gasSpec }, refs: refs as never, open: true, adviser: "Your NZI adviser", onSaved: async () => undefined }));
      assert.match(html, /<option value="ds:gas-demo" selected="">Natural gas/);
      assert.doesNotMatch(html, /<option value="ds:diesel" selected=""/);
    });

    it("History is its own container in the CRM drawer too — no longer inside Evidence & provenance", async () => {
      const { RowHistory } = await components();
      const editor = read("apps/console/app/jobs/CrpScopeWorkspace.tsx");
      const evidence = editor.slice(editor.indexOf('<Collapsible title="Evidence & provenance"'), editor.indexOf("</Collapsible>", editor.indexOf('<Collapsible title="Evidence & provenance"')));
      assert.doesNotMatch(evidence, /Activity history|history\.map/, "History is out of Evidence & provenance");
      assert.match(editor, /<RowHistory state=\{historyState\} open=\{showHistory\}/);
      assert.match(editor, /aria-expanded=\{showHistory\} onClick=\{\(\) => setShowHistory\(\(prev\) => !prev\)\}>History</);
      const states = (state: "loading" | "ready" | "failed") => renderToStaticMarkup(createElement(RowHistory, { state, entries: [], open: true, onOpenChange: () => undefined }));
      assert.match(states("loading"), /Loading the row(?:&#x27;|')s history/);
      assert.match(states("failed"), /unavailable\. No events have been inferred/);
      assert.match(states("ready"), /No events are recorded for this row yet/);
    });
  });

  describe("boundaries", () => {
    it("every route is the portal's: dark behind portal-data, a portal session, the origin check on writes, its own command — never a staff route", () => {
      const routes = ["data-view/route.ts", "scope-rows/route.ts", "scope-rows/[rowId]/route.ts", "scope-rows/[rowId]/deactivate/route.ts", "scope-rows/[rowId]/history/route.ts", "declared-factor/route.ts"];
      for (const path of routes) {
        const source = read(`apps/console/app/api/portal/jobs/[jobId]/${path}`);
        assert.match(source, /requirePortalData\(\);/, path);
        assert.match(source, /currentPortalUserForData\(request\)/, path);
        assert.doesNotMatch(source, /requireCommandPrincipal|currentStaff/, path);
      }
      for (const [path, command] of [["scope-rows/route.ts", "createPortalScopeRow"], ["scope-rows/[rowId]/route.ts", "updatePortalScopeRow"], ["scope-rows/[rowId]/deactivate/route.ts", "deactivatePortalScopeRow"]]) {
        const source = read(`apps/console/app/api/portal/jobs/[jobId]/${path}`);
        assert.match(source, /requirePortalOrigin\(request\);/, path);
        assert.match(source, new RegExp(`${command}\\(isolatedPool\\(\\), \\{[^}]*\\}, portalCommandContext\\(request, user\\)\\)`), path);
      }
      const view = read("apps/console/app/portal/jobs/[jobId]/data/PortalDataView.tsx");
      assert.doesNotMatch(view, /\/api\/isolated/, "the client's view calls no staff route");
    });

    it("the switch-over: dark by absence; once on, the records path takes no new writes and the old tab points to the Data view", () => {
      assert.match(read("apps/console/app/lib/portalFlags.ts"), /\| "portal-data"\n/);
      // Shipped dark (#504), switched on in the dashboard and added to render.yaml in step; the full value is the rollout pin's.
      assert.match(read("render.yaml"), /value: [^\n]*\bportal-data\b/);
      assert.match(read("apps/console/app/portal/jobs/[jobId]/data/page.tsx"), /if \(!portalFeatureEnabled\("portal-data"\)\) redirect/);
      const records = read("apps/console/app/api/portal/jobs/[jobId]/data-entry-records/route.ts");
      for (const method of ["POST", "PATCH", "DELETE"]) assert.match(records, new RegExp(`export async function ${method}\\([^)]*\\)\\{try\\{if\\(portalFeatureEnabled\\("portal-data"\\)\\)return moved\\(\\);`), method);
      assert.match(records, /export async function GET\(request:Request,\{params\}:\{params:Promise<\{jobId:string\}>\}\)\{try\{const user/, "reads stay, so nothing entered is hidden");
      assert.match(read("apps/console/app/portal-preview/PortalWorkspace.tsx"), /tab==="data"&&portalFeatureEnabled\("portal-data"\)\?<DataMoved/);
      assert.match(read("apps/console/app/portal/PortalHome.tsx"), /portalFeatureEnabled\("portal-data"\)\?<a className="nz-btn" href=\{`\/portal\/jobs\/\$\{job\.id\}\/data`\}>Your data<\/a>:null/);
    });

    it("Portal Management and the preview say the settings are in force once the view is on (§6)", () => {
      assert.match(read("apps/console/app/clients/[clientId]/PortalManagementArea.tsx"), /portalFeatureEnabled\("portal-data"\) \? "These settings are in force in the client's portal/);
      assert.match(read("apps/console/app/clients/[clientId]/portal-preview/PortalPreview.tsx"), /portalFeatureEnabled\("portal-data"\) \? "These settings are in force in the portal\."/);
    });

    it("no fee, rate, turnover or currency total is shown back to the client (NZC-120)", async () => {
      const { PortalRowDrawer } = await components();
      const html = renderToStaticMarkup(createElement(PortalRowDrawer, { jobId: "job-1", row: row(), view: view(), specs: { "1.natural-gas": gasSpec }, refs: [], open: true, adviser: "Your NZI adviser", onSaved: async () => undefined }));
      assert.doesNotMatch(html, /£|€|\$|turnover|revenue|fee|rate card/i);
    });
  });
});
