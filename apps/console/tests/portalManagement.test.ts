import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PORTAL_PROFILE_DEFAULT, PORTAL_PROFILE_KEYS, PORTAL_PROFILE_LABELS, PORTAL_PROFILE_VALUES, PORTAL_SCOPE_LABELS, PORTAL_SCOPES, type PortalProfileStaffView,
} from "@nzi/contracts";
import { clientAreaGroups, CLIENT_AREA_LABELS } from "../app/clients/[clientId]/clientAreas";
import type * as AreaModule from "../app/clients/[clientId]/PortalManagementArea";
type PortalManagementTab = AreaModule.PortalManagementTab;
import type { EditAccess } from "../app/lib/useEditAccess";

/**
 * Portal Management (portal data-entry phase 1; BUILD-portal-dataentry-phase1 §5; redesign: DESIGN-portal-management) and the staff
 * preview's explanation: the area is offered only behind its flag to a portal.admin holder; it is tabs (Access · Users · Visibility ·
 * Scopes & categories · Jobs · Files · History), of which Visibility and Scopes & categories are live; a switch is wordless (on = shown);
 * there is no per-area description, no Datasets and no Setup; one "Reset all to default" per tab; the detailed row drawer's sections
 * show only when it is on; every change is one of the three governed commands. The commands and the read are `clientPortalProfileReal`.
 */
(globalThis as { React?: unknown }).React = React;
// @nzi/ui is JSX that reads the global React when it loads, so the area is imported only once the global is set.
let PortalManagementBody: typeof AreaModule.PortalManagementBody, HIDDEN_PROFILE_KEYS: typeof AreaModule.HIDDEN_PROFILE_KEYS;
before(async () => { ({ PortalManagementBody, HIDDEN_PROFILE_KEYS } = await import("../app/clients/[clientId]/PortalManagementArea")); });
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const allowed: EditAccess = { state: "allowed" };
const decision = <V,>(value: V, note = "") => ({ value, note, decidedBy: "u-1", decidedByName: "Cass Consultant", decidedAt: "2026-10-22T09:00:00.000Z" });

const VIEW: PortalProfileStaffView = {
  clientId: "client-a",
  profile: PORTAL_PROFILE_KEYS.map((key) => ({
    key, ...PORTAL_PROFILE_LABELS[key], values: PORTAL_PROFILE_VALUES[key], defaultValue: PORTAL_PROFILE_DEFAULT[key],
    effectiveValue: key === "time" ? "visible" : key === "entryDrawer" ? "detailed" : key === "dataQuality" ? "visible" : PORTAL_PROFILE_DEFAULT[key],
    decision: key === "time" ? decision("visible", "Client books their own time") : key === "setup" ? decision("hidden") : key === "entryDrawer" ? decision("detailed") : null,
  })),
  scopes: PORTAL_SCOPES.map((scope) => ({
    scope, label: PORTAL_SCOPE_LABELS[scope], effectiveVisible: scope !== "1",
    decision: scope === "1" ? decision(false, "No direct emissions") : null,
    categories: scope === "1"
      ? [{ categoryCode: "1", name: "Stationary combustion", shown: false, hiddenBy: "scope" as const, decision: null }]
      : scope === "3"
        ? [{ categoryCode: "3.6", name: "Business travel", shown: false, hiddenBy: "category" as const, decision: decision(false) },
          { categoryCode: "3.7", name: "Employee commuting", shown: true, hiddenBy: null, decision: null }]
        : [],
  })),
};
const body = (over: Partial<Parameters<typeof AreaModule.PortalManagementBody>[0]> = {}, tab: PortalManagementTab = "visibility") => renderToStaticMarkup(createElement(PortalManagementBody, {
  load: { state: "ready", view: VIEW }, note: "", onNote: () => undefined, pending: null, message: null, tab, onTab: () => undefined,
  profileAccess: allowed, visibilityAccess: allowed, onRetry: () => undefined, onSend: () => undefined, onResetAll: () => undefined, ...over,
}));
/** The tab panel that is showing, so a test reads what the user sees and not the hidden panels. */
const panel = (html: string, id: string) => html.match(new RegExp(`id="pm-panel-${id}"[^>]*>([\\s\\S]*?)</div>(?=<div role="tabpanel"|</div></section>)`))?.[0] ?? "";

describe("Portal Management (portal data-entry phase 1)", () => {
  it("is offered in Manage only when the workspace says so — behind portal-management, to a portal.admin holder on this client", () => {
    const manage = (showPortal: boolean) => clientAreaGroups({}, false, showPortal).find((group) => group.id === "manage")!.items.map((item) => item.id);
    assert.deepEqual(manage(false), ["tasks", "notes", "files", "comms"]);
    assert.deepEqual(manage(true), ["tasks", "notes", "files", "comms", "portal"]);
    assert.equal(CLIENT_AREA_LABELS.portal, "Portal Management");
    assert.equal(clientAreaGroups({}, false, true).find((group) => group.id === "manage")!.items.find((item) => item.id === "portal")!.unavailable, false);
    const view = read("apps/console/app/clients/[clientId]/ClientWorkspaceView.tsx");
    assert.match(view, /const canManagePortal = useHasCapability\("portal\.admin", client\.ownerUserId\) && portalFeatureEnabled\("portal-management"\);/);
    assert.match(view, /clientAreaGroups\(\{[\s\S]*?\}, canReadHistory, canManagePortal\)/);
    assert.match(view, /area === "portal" && canManagePortal \? <PortalManagementArea/);
  });

  it("is gated on its own token, which is declared — and, switched on, carried by staging's flag value", () => {
    assert.match(read("apps/console/app/lib/portalFlags.ts"), /\| "portal-management"(?=[;\s])/);
    assert.match(read("render.yaml"), /value: [^\n]*\bportal-management\b/);
  });
});

describe("Portal Management tabs (redesign)", () => {
  it("names the seven tabs in the designed order, with Visibility and Scopes & categories live and the rest not selectable yet", () => {
    const html = body();
    const tabs = [...html.matchAll(/<button[^>]*role="tab"([^>]*)>([^<]*)<\/button>/g)].map((match) => [match[2], /aria-disabled="true"/.test(match[1]!)]);
    assert.deepEqual(tabs, [["Access", true], ["Users", true], ["Visibility", false], ["Scopes &amp; categories", false], ["Jobs", true], ["Files", true], ["History", true]]);
    assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*class="on">Visibility</);
    assert.match(body({ files: createElement("p", null, "Files here") }, "files"), /role="tab"[^>]*aria-controls="pm-panel-files"[^>]*>Files</);
    assert.doesNotMatch(body({ files: createElement("p", null, "Files here") }), /aria-disabled="true"[^>]*>Files</, "Files is live when it is on");
    assert.match(body({}, "access"), /This tab is not available yet\./);
  });

  it("draws the Visibility switches wordless — on = shown — with no area descriptions, no Datasets, no Setup and no default markers", () => {
    const html = panel(body(), "visibility");
    const switches = [...html.matchAll(/<button[^>]*role="switch" aria-checked="(true|false)"[^>]*aria-label="([^"]+)"/g)].map((match) => [match[2], match[1]]);
    assert.deepEqual(switches, [["Time", "true"], ["Milestones", "true"], ["Detailed row drawer", "true"], ["Evidence &amp; provenance", "false"], ["Factor &amp; calculation", "false"], ["Data quality", "true"], ["Source detail", "false"], ["Deactivate a row", "false"]]);
    for (const absent of ["Datasets", "Setup", "Shown", "Hidden", "badge", ">default<", "(default", ">Return to default<", "The job&#x27;s", "Adding and editing", "In the detailed row drawer"]) assert.ok(!html.includes(absent), absent);
    assert.doesNotMatch(html, /Decision · |Default, confirmed/, "who decided is on the row's tooltip, not printed on it");
    assert.match(html, /title="Decided by Cass Consultant · 22\/10\/2026 · “Client books their own time”"/);
    assert.deepEqual([...HIDDEN_PROFILE_KEYS], ["setup", "datasets"]);
  });

  it("shows the detailed row drawer's four sections only when it is on", () => {
    const off: PortalProfileStaffView = { ...VIEW, profile: VIEW.profile.map((entry) => (entry.key === "entryDrawer" ? { ...entry, effectiveValue: "simple", decision: null } : entry)) };
    const html = panel(body({ load: { state: "ready", view: off } }), "visibility");
    assert.match(html, /aria-checked="false"[^>]*aria-label="Detailed row drawer"/);
    for (const section of ["Evidence &amp; provenance", "Factor &amp; calculation", "Data quality", "Source detail"]) assert.ok(!html.includes(section), section);
    assert.match(panel(body(), "visibility"), /class="nz-pm-sub"/);
  });

  it("has one Reset all to default per tab, on only when there is a decision to withdraw, and says History is not a setting", () => {
    const html = panel(body(), "visibility");
    assert.equal((html.match(/Reset all to default/g) ?? []).length, 1);
    assert.doesNotMatch(html, /nz-pm-reset"[^>]*disabled=""/, "Visibility has decisions in force (Time, Detailed row drawer)");
    assert.match(html, /History — a row(?:&#x27;|')s change history is always visible to the client\. It is not a setting\./);
    const plain: PortalProfileStaffView = { ...VIEW, profile: VIEW.profile.map((entry) => ({ ...entry, decision: null })) };
    assert.match(panel(body({ load: { state: "ready", view: plain } }), "visibility"), /nz-pm-reset"[^>]*aria-disabled="true" disabled=""/, "nothing to reset: the control is inert");
    assert.equal((panel(body({}, "scopes"), "scopes").match(/Reset all to default/g) ?? []).length, 1);
    assert.doesNotMatch(html, /sign[- ]?off<\/button>|release<\/button>|Send message|later phases/i);
  });

  it("shows scopes and categories with the same wordless switches, why a category is off, and Overridden · Reset where a decision is in force", () => {
    const html = panel(body({}, "scopes"), "scopes");
    const switches = [...html.matchAll(/<button[^>]*role="switch" aria-checked="(true|false)"[^>]*aria-label="([^"]+)"/g)].map((match) => [match[2], match[1]]);
    assert.deepEqual(switches, [["Scope 1 — direct", "false"], ["Stationary combustion", "true"], ["Scope 2 — purchased energy", "true"], ["Scope 3 — value chain", "true"], ["Business travel", "false"], ["Employee commuting", "true"]]);
    assert.match(html, /Stationary combustion[\s\S]*?\(its scope is off\)/);
    assert.equal((html.match(/Overridden · /g) ?? []).length, 2, "Scope 1 and Business travel");
    assert.equal((html.match(/>Reset</g) ?? []).length, 2);
    assert.doesNotMatch(html, />Shown<|>Hidden<|>Hide<|>Show<|Return to default/);
  });

  it("a member of staff without the capability sees the switches but cannot change them, and is told why", () => {
    const html = body({ profileAccess: { state: "denied", reason: "Your role does not include portal administration." } });
    assert.match(html, /You can see portal settings but not change them: Your role does not include portal administration\./);
    assert.match(html, /aria-label="Time"[^>]*aria-disabled="true"|aria-disabled="true"[^>]*aria-label="Time"/);
  });

  it("loading, refused and failed are three different things, never an empty profile", () => {
    assert.match(body({ load: { state: "loading" } }), /Loading this client(?:&#x27;|')s portal profile/);
    assert.match(body({ load: { state: "denied" } }), /it needs portal\.admin/);
    assert.match(body({ load: { state: "failed" } }), /could not be loaded\. Nothing is shown rather than a profile that might be wrong/);
    for (const state of ["loading", "denied", "failed"] as const) assert.doesNotMatch(panel(body({ load: { state } }), "visibility"), /role="switch"|Reset all/);
  });

  it("each switch sends its own governed command, through its own route; Reset all withdraws each decision once and refreshes once", () => {
    const source = read("apps/console/app/clients/[clientId]/PortalManagementArea.tsx");
    assert.match(source, /onSend\(key, "\/portal-profile", \{ profileKey: key, value: on \? ON_VALUE\[key\] : OFF_VALUE\[key\] \}/);
    assert.match(source, /"\/portal-profile\/scopes", \{ scope: scope\.scope, visible: !scope\.effectiveVisible \}/);
    assert.match(source, /"\/category-visibility", \{ categoryCode: category\.categoryCode, visible: !on \}/);
    assert.match(source, /\{ profileKey: entry\.key, value: null \}/);
    assert.match(source, /\{ scope: scope\.scope, visible: null \}/);
    assert.match(source, /\{ categoryCode: category\.categoryCode, visible: null \}/);
    const resetAll = source.slice(source.indexOf("async function resetAll"), source.indexOf("return <PortalManagementBody"));
    assert.equal((resetAll.match(/await refresh\(\)/g) ?? []).length, 2, "refreshed once on success and once if it stops early — never per decision");
    assert.match(resetAll, /for \(const command of commands\)/);
    const routes = "apps/console/app/api/isolated/clients/[clientId]";
    assert.match(read(`${routes}/portal-profile/route.ts`), /requireCommandPrincipal\(request, "client\.portal\.profile\.set"\)/);
    assert.match(read(`${routes}/portal-profile/route.ts`), /getPortalProfileForStaff\(isolatedPool\(\), principal, clientId\)/);
    assert.match(read(`${routes}/portal-profile/scopes/route.ts`), /requireCommandPrincipal\(request, "client\.portal\.scope\.visibility\.set"\)/);
    assert.match(read(`${routes}/category-visibility/route.ts`), /requireCommandPrincipal\(request, "client\.category\.visibility\.set"\)/);
  });

  it("never writes the removed settings: Datasets and Setup have no control and no command from this screen", () => {
    const source = read("apps/console/app/clients/[clientId]/PortalManagementArea.tsx");
    assert.doesNotMatch(source, /profileKey: "(?:setup|datasets)"/);
    assert.match(source, /HIDDEN_PROFILE_KEYS = \["setup", "datasets"\]/);
    assert.match(source, /filter\(\(entry\) => !\(HIDDEN_PROFILE_KEYS as readonly string\[\]\)\.includes\(entry\.key\)\)/);
  });

  it("the staff preview explains how this client's portal differs from the default — and says when it does not", async () => {
    const { PortalPreview } = await import("../app/clients/[clientId]/portal-preview/PortalPreview");
    const preview = (profile: PortalProfileStaffView) => renderToStaticMarkup(createElement(PortalPreview, { preview: {
      client: { id: "client-a", name: "Client A", logoAssetId: null }, previewedAt: "2026-10-22T09:00:00.000Z", profile,
      strategies: { state: "empty" } as never, readiness: { state: "empty" } as never, jobs: [], job: null,
    } }));
    const differs = preview(VIEW);
    assert.match(differs, /Staff only — this client(?:&#x27;|’|&rsquo;)s portal profile\./);
    for (const line of ["Time: Shown (default Hidden)", "Scope 1 — direct: hidden, with every category in it", "Business travel: hidden"]) assert.ok(differs.includes(line), line);
    const plain: PortalProfileStaffView = { clientId: "c", profile: VIEW.profile.map((entry) => ({ ...entry, effectiveValue: entry.defaultValue, decision: null })), scopes: VIEW.scopes.map((scope) => ({ ...scope, effectiveVisible: true, decision: null, categories: scope.categories.map((category) => ({ ...category, shown: true, hiddenBy: null, decision: null })) })) };
    assert.match(preview(plain), /It is your organisation(?:&#x27;|')s default: nothing has been decided differently for this client\./);
  });

  it("History says each decision in words", () => {
    const history = read("apps/console/app/clients/[clientId]/HistoryArea.tsx");
    for (const action of ["client_portal_profile_set", "client_portal_scope_visibility_set", "client_category_visibility_set"]) assert.ok(history.includes(`/^${action}$/`), action);
  });
});
