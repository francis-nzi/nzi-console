import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AREA_TAB, CLIENT_AREA_IDS, CLIENT_TABS, CLIENT_TAB_IDS, tabForParam, type ClientAreaId, type ClientTabId } from "../app/clients/[clientId]/clientAreas";
import { listActiveMasterTemplateChoices } from "../../../packages/isolated-backend/src/clientReportingTemplateRecords";

/**
 * Client workspace reallocation: the left sub-nav became a top tab bar (Overview · Carbon · Data entry · Reporting · Reduction
 * Strategies · SRS Readiness · Record · Manage), the Overview became at-a-glance only, and each working section moved — unchanged — to its tab. Plus the data-entry
 * picker fix. Nothing is dropped: every area that was reachable from the sub-nav is reachable under some tab.
 */
(globalThis as { React?: unknown }).React = React;
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const client = (file: string) => read(`apps/console/app/clients/[clientId]/${file}`);

/** The JSX a tab renders, as written in the shell's `tabBody`. */
const tabSource = (tab: ClientTabId): string => {
  const view = client("ClientWorkspaceView.tsx");
  const body = view.slice(view.indexOf("const tabBody"), view.indexOf("return <AppShell"));
  const start = body.indexOf(`case "${tab}":`);
  assert.ok(start >= 0, `tabBody has a case for ${tab}`);
  const rest = body.slice(start + 1);
  const next = rest.search(/case "/);
  return next < 0 ? body.slice(start) : body.slice(start, start + 1 + next);
};

describe("the client tab bar", () => {
  it("has the eight tabs, in order, and renders as a tablist with the active one selected", async () => {
    assert.deepEqual(CLIENT_TABS.map((tab) => tab.label), ["Overview", "Carbon", "Data entry", "Reporting", "Reduction Strategies", "SRS Readiness", "Record", "Manage"]);
    const { Tabs } = await import("@nzi/ui");
    const html = renderToStaticMarkup(createElement(Tabs, { items: CLIENT_TABS, value: "carbon", onChange: () => undefined, ariaLabel: "Client sections", idBase: "client", className: "nz-tabs" }));
    assert.match(html, /role="tablist" aria-label="Client sections" class="nz-tabs"/);
    assert.equal((html.match(/role="tab"/g) ?? []).length, 8);
    assert.match(html, /id="client-tab-carbon"[^>]*aria-selected="true"/);
    assert.match(html, /id="client-tab-overview"[^>]*aria-selected="false"/);
  });

  it("switches by tab, keeps the tab in the URL, and sends an old ?area= link to the tab that now holds it", () => {
    const view = client("ClientWorkspaceView.tsx");
    assert.match(view, /<Tabs className="nz-tabs" items=\{CLIENT_TABS\} value=\{tab\} onChange=\{selectTab\}/);
    assert.match(view, /window\.history\.replaceState\(null, "", target === "overview" \?/);
    assert.doesNotMatch(view, /ClientWorkspaceNav|clientAreaGroups/, "the left sub-nav is gone");
    assert.equal(tabForParam("srs"), "srs");
    assert.equal(tabForParam("strategies"), "strategies");
    assert.equal(tabForParam("analytics"), "carbon");
    assert.equal(tabForParam("reporting"), "reporting");
    assert.equal(tabForParam("history"), "manage");
    assert.equal(tabForParam("carbon"), "carbon");
    assert.equal(tabForParam("nonsense"), "overview");
    assert.equal(tabForParam(undefined), "overview");
  });
});

describe("the Overview is at-a-glance only", () => {
  const workspace = {
    client: { id: "c1", completeness: 40, sector: "Retail", profile: { financialYearEndMonth: 3 } },
    sites: [], contacts: [{ id: "k2", fullName: "Bo Second", isPrimary: false, jobTitle: "Analyst", email: null }, { id: "k1", fullName: "Ada Primary", isPrimary: true, jobTitle: "CFO", email: "ada@example.test" }],
    targets: { benchmarkInForce: null, model: null }, history: [],
    evidence: { state: "empty", latest: { value: null, source: null }, yoy: { value: null }, scopes: [] },
  } as never;
  let OverviewArea: typeof import("../app/clients/[clientId]/OverviewArea").OverviewArea;
  before(async () => { ({ OverviewArea } = await import("../app/clients/[clientId]/OverviewArea")); });

  it("shows setup progress, the headline, delivery with rows awaiting review, and a compact key-contacts card — primary first", () => {
    const html = renderToStaticMarkup(createElement(OverviewArea, { workspace, jobs: [], today: "2026-11-05", onEvidence: () => undefined, onOpenTab: () => undefined }));
    for (const text of ["Client setup progress", "Latest verified emissions", "Active jobs &amp; milestone progress", "Key contacts", "Latest emissions"]) assert.ok(html.includes(text), text);
    assert.ok(html.indexOf("Ada Primary") < html.indexOf("Bo Second"), "the primary contact leads");
    // Not the working sections — those live on their tabs.
    for (const text of ["Emissions history", "Baseline &amp; targets", "Data entry template", "Report profile", "Activity", "Company profile", "Financial status"]) assert.ok(!html.includes(text), `${text} is not on the Overview`);
  });

  it("carries no editing controls: no drawer, no form, no command — only links onward to the tab that holds the section", () => {
    const source = client("OverviewArea.tsx");
    assert.doesNotMatch(source, /onDrawer|DrawerRequest|postBrowserCommand|putBrowserCommand|<input|<textarea|<select|GatedButton|useEditAccess/);
    assert.equal((source.match(/defaultOpen/g) ?? []).length, 1, "only the delivery card opens by default (DESIGN_CONVENTIONS 3.2)");
    for (const tab of ["carbon", "record"]) assert.match(source, new RegExp(`onOpenTab\\("${tab}"\\)`), `links to ${tab}`);
  });
});

describe("every client area is still reachable under a tab", () => {
  it("places every area, on a real tab", () => {
    for (const area of CLIENT_AREA_IDS) assert.ok(CLIENT_TAB_IDS.includes(AREA_TAB[area]), `${area} has a tab`);
    for (const tab of CLIENT_TAB_IDS) assert.ok(CLIENT_AREA_IDS.some((area) => AREA_TAB[area] === tab) || ["data-entry"].includes(tab), `${tab} hosts something`);
  });

  it("renders each area's component under the tab AREA_TAB names, and each relocated Overview section under its tab", () => {
    const hosts: Record<ClientAreaId, string> = {
      overview: "<OverviewArea", analytics: "<AnalyticsArea", strategies: "<ReductionStrategiesArea", reporting: "<ReportingArea", srs: "<SrsArea",
      profile: "<RecordTab", financials: "<FinancialsHeldArea", ai: "<AiProfileArea", tasks: '<UnavailableArea area="tasks"', notes: '<UnavailableArea area="notes"',
      files: "<FilesArea", comms: "<CommsArea", portal: "<PortalManagementArea", history: "<HistoryArea",
    };
    for (const area of CLIENT_AREA_IDS) assert.ok(tabSource(AREA_TAB[area]).includes(hosts[area]), `${area} → ${hosts[area]} under ${AREA_TAB[area]}`);
    const moved: Array<[ClientTabId, string]> = [
      ["carbon", "<EmissionsHistoryCard"], ["carbon", "<BaselineTargetsCard"],
      ["data-entry", "<ReportingTemplateCard"],
      ["reporting", "<ReportProfileCard"],
      ["manage", "<ActivityCard"],
    ];
    for (const [tab, component] of moved) assert.ok(tabSource(tab).includes(component), `${component} under ${tab}`);
    // Record: the right rail's contacts, sites and vehicles, with the company profile.
    const record = client("ClientTabCards.tsx");
    for (const component of ["<ProfileArea", "<ClientContacts", "<ClientSites", "<VehicleRegistrationsCard"]) assert.ok(record.includes(component), `${component} under Record`);
  });

  it("gives Reduction Strategies and SRS Readiness their own tabs, and renders each only there", () => {
    assert.equal(AREA_TAB.strategies, "strategies");
    assert.equal(AREA_TAB.srs, "srs");
    assert.ok(!tabSource("carbon").includes("<ReductionStrategiesArea"), "not on Carbon");
    assert.ok(!tabSource("reporting").includes("<SrsArea"), "not on Reporting");
    for (const [tab, kept] of [["carbon", ["<EmissionsHistoryCard", "<BaselineTargetsCard", "<AnalyticsArea"]], ["reporting", ["<ReportingArea", "<ReportProfileCard"]]] as const) {
      for (const component of kept) assert.ok(tabSource(tab).includes(component), `${component} stays on ${tab}`);
    }
  });

  it("keeps the gates it had: History under audit.view, Portal Management under the flag + portal.admin", () => {
    const manage = tabSource("manage");
    assert.match(manage, /\{canReadHistory \? <HistoryArea/);
    assert.match(manage, /\{canManagePortal\s*\? <PortalManagementArea/);
    assert.match(manage, /Portal Management is not available here/);
  });
});

describe("the data entry template picker", () => {
  const masters = [
    { masterId: "m1", name: "Default", lineCount: 1, selectable: true },
    { masterId: "m2", name: "Construction", lineCount: 12, selectable: true },
    { masterId: "m3", name: "Office", lineCount: 0, selectable: false },
  ];
  const template = { current: null, latestVersion: 0, categories: [], masters } as never;

  it("prompts, names masters in full with their line count, and disables an empty one", async () => {
    const { ReportingTemplateFromMasterForm } = await import("../app/clients/[clientId]/ClientReportingTemplate");
    const html = renderToStaticMarkup(createElement(ReportingTemplateFromMasterForm, { clientId: "c1", template, access: { state: "allowed" } as never, onClose: () => undefined, onSaved: () => undefined }));
    // The prompt is the selected option, so nothing is chosen until the person chooses.
    assert.match(html, /<option value="" selected="">Choose a template…<\/option>/);
    assert.ok(html.indexOf("Choose a template…") < html.indexOf("Master · Default"), "the prompt comes first");
    assert.match(html, /<option value="m1">Master · Default — 1 line<\/option>/);
    assert.match(html, /<option value="m2">Master · Construction — 12 lines<\/option>/);
    assert.match(html, /<option value="m3" disabled="">Master · Office — no lines yet<\/option>/);
    assert.match(html, /aria-disabled="true"[^>]*>Initialise template<\/button>/, "and the action stays blocked until then");
  });

  it("reads active-but-empty masters into the model, flagged not selectable — and still leaves archived ones out", async () => {
    let sql = "";
    const db = { query: async (text: string) => { sql = text; return { rows: [{ master_id: "m1", name: "Default", line_count: "1" }, { master_id: "m3", name: "Office", line_count: "0" }] }; } };
    const choices = await listActiveMasterTemplateChoices(db as never);
    assert.deepEqual(choices, [{ masterId: "m1", name: "Default", lineCount: 1, selectable: true }, { masterId: "m3", name: "Office", lineCount: 0, selectable: false }]);
    assert.match(sql, /WHERE m\.active /, "archived masters stay out");
    assert.doesNotMatch(sql, /rows_version\s*>\s*0/, "an empty master is no longer filtered out");
  });
});

describe("one title per section", () => {
  const SECTION_FILES = ["ClientReportingTemplate.tsx", "ClientReportProfile.tsx", "ClientTabCards.tsx", "ClientTargets.tsx", "ProfileArea.tsx", "ClientContacts.tsx", "ClientSites.tsx",
    "ClientIdentity.tsx", "AiProfileArea.tsx", "AnalyticsArea.tsx", "ReportingArea.tsx", "SrsArea.tsx", "CommsFilesAreas.tsx", "HistoryArea.tsx", "PortalManagementArea.tsx", "OverviewArea.tsx", "VehicleRegistrationsCard.tsx", "ClientPathway.tsx"];

  it("never sets a group eyebrow in front of a section heading — the tab already names the group", () => {
    for (const file of SECTION_FILES) {
      assert.doesNotMatch(client(file), /className="eyebrow">[^<]*<\/(?:div|span)><h2/, `${file}: an eyebrow directly above an <h2>`);
    }
  });

  it("collapses the named doubles to one plain heading", () => {
    const rendered = client("ClientReportingTemplate.tsx") + client("ClientTabCards.tsx") + client("ProfileArea.tsx");
    assert.match(rendered, /<h2>Data entry template<\/h2>/);
    assert.match(rendered, /<h2>Baseline &amp; targets<\/h2>/);
    assert.match(rendered, /<h2>Company profile<\/h2>/);
    for (const doubled of ["Data entry</span><h2>Data entry template", "Record</div><h2>Company profile", "Commitment</span><h2>Baseline"]) assert.ok(!rendered.includes(doubled), doubled);
  });

  it("an eyebrow that is a CardHead prop is optional and renders nothing when absent", async () => {
    const { CardHead } = await import("../app/clients/[clientId]/OverviewArea");
    assert.doesNotMatch(renderToStaticMarkup(createElement(CardHead, { title: "Key contacts" })), /eyebrow/);
    assert.match(renderToStaticMarkup(createElement(CardHead, { eyebrow: "FY25", title: "Scope split" })), /class="eyebrow">FY25</);
  });
});

describe("helper prose sits behind an i-pill", () => {
  it("the data entry template's description is in the InfoTip, not inline", async () => {
    const { ReportingTemplateCard } = await import("../app/clients/[clientId]/ClientReportingTemplate");
    const html = renderToStaticMarkup(createElement(ReportingTemplateCard, { template: { current: null, latestVersion: 0, categories: [], masters: [] } as never, access: { state: "allowed" } as never, onEdit: () => undefined, onInitialise: () => undefined, onInitialiseFromMaster: () => undefined }));
    // Collapsed by default, so the head renders; the explanatory sentence must not be a bare paragraph.
    assert.doesNotMatch(html, /<p class="sub">No data entry template yet\. It holds/);
    const source = client("ClientReportingTemplate.tsx");
    assert.match(source, /<InfoTip label="the data entry template">It holds the rows/);
  });

  it("targets, report profile, baseline record, client factors, portal access and report versions explain themselves in an InfoTip", () => {
    assert.match(client("ClientTargets.tsx"), /<InfoTip label="targets">Targets are reductions against the baseline/);
    assert.match(client("ClientReportProfile.tsx"), /<InfoTip label="the report profile">/);
    assert.match(client("ClientTabCards.tsx"), /<InfoTip label="the baseline record">/);
    assert.match(client("ProfileArea.tsx"), /<InfoTip label="client factors">/);
    assert.match(client("ProfileArea.tsx"), /<InfoTip label="portal access">/);
    assert.match(client("ReportingArea.tsx"), /<InfoTip label="report versions">/);
    assert.doesNotMatch(client("ClientTargets.tsx"), /<p className="nz-maps">Targets are reductions/);
    assert.doesNotMatch(client("ReportingArea.tsx"), /<p className="nz-maps">A published report/);
  });
});
