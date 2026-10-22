import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PORTAL_PROFILE_DEFAULT, PORTAL_PROFILE_KEYS, PORTAL_PROFILE_LABELS, PORTAL_PROFILE_VALUES, PORTAL_SCOPE_LABELS, PORTAL_SCOPES, type PortalProfileStaffView,
} from "@nzi/contracts";
import { clientAreaGroups, CLIENT_AREA_LABELS } from "../app/clients/[clientId]/clientAreas";
import { PortalManagementBody } from "../app/clients/[clientId]/PortalManagementArea";
import type { EditAccess } from "../app/lib/useEditAccess";

/**
 * Portal Management (portal data-entry phase 1; BUILD-portal-dataentry-phase1 §5) and the staff preview's explanation:
 * the area is offered only behind its flag to a portal.admin holder; it shows each setting's effective value and whether
 * that is the default or a decision (who, when, why); every change is one of the three governed commands; History is said
 * to be always visible; nothing of the later phases is built. The commands and the read are `clientPortalProfileReal`.
 */
(globalThis as { React?: unknown }).React = React;
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const allowed: EditAccess = { state: "allowed" };
const decision = <V,>(value: V, note = "") => ({ value, note, decidedBy: "u-1", decidedByName: "Cass Consultant", decidedAt: "2026-10-22T09:00:00.000Z" });

const VIEW: PortalProfileStaffView = {
  clientId: "client-a",
  profile: PORTAL_PROFILE_KEYS.map((key) => ({
    key, ...PORTAL_PROFILE_LABELS[key], values: PORTAL_PROFILE_VALUES[key], defaultValue: PORTAL_PROFILE_DEFAULT[key],
    effectiveValue: key === "time" ? "visible" : PORTAL_PROFILE_DEFAULT[key],
    decision: key === "time" ? decision("visible", "Client books their own time") : key === "setup" ? decision("hidden") : null,
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
const body = (over: Partial<Parameters<typeof PortalManagementBody>[0]> = {}) => renderToStaticMarkup(createElement(PortalManagementBody, {
  load: { state: "ready", view: VIEW }, note: "", onNote: () => undefined, pending: null, message: null,
  profileAccess: allowed, visibilityAccess: allowed, onRetry: () => undefined, onSend: () => undefined, ...over,
}));

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

  it("ships dark: the token is declared, and staging's flag value does not carry it", () => {
    assert.match(read("apps/console/app/lib/portalFlags.ts"), /\| "portal-management";/);
    assert.doesNotMatch(read("render.yaml"), /portal-management/);
  });

  it("shows every setting's effective value and where it comes from — the default, or a decision with who, when and why", () => {
    const html = body();
    for (const text of ["Portal Management", "Areas", "Entry", "Detailed row drawer — sections", "Actions", "Setup", "Time", "Milestones", "Evidence &amp; provenance", "Deactivate a row"]) assert.ok(html.includes(text), text);
    assert.match(html, /Decision · Cass Consultant · 22\/10\/2026 · <q>Client books their own time<\/q>/);
    assert.match(html, /Default, confirmed · Cass Consultant/, "the default restated is a decision, and said so");
    assert.equal((html.match(/>Return to default</g) ?? []).length, 2 + 1 + 1, "only where a decision is in force (two settings, one scope, one category)");
    assert.match(html, /aria-pressed="true"[^>]*>Shown<span class="badge">default<\/span>/, "the effective value is the pressed one");
    assert.match(html, /aria-label="Milestones"[\s\S]*?>View only<span class="badge">default<\/span>[\s\S]*?>Hidden</);
    assert.doesNotMatch(html, />Edit</, "milestones are never offered as editable");
  });

  it("says History is always visible and not a setting, and builds nothing of the later phases", () => {
    const html = body();
    assert.match(html, /Always visible to the client/);
    assert.match(html, /it is not a setting and cannot be switched off/);
    assert.doesNotMatch(html, /sign[- ]?off<\/button>|release<\/button>|Send message/i);
    assert.match(html, /Sign-off, report release and messaging are managed here in later phases\./);
  });

  it("shows scopes with their categories, why a category is hidden, and which phase each setting is live in", () => {
    const html = body();
    assert.match(html, /Scope 1 — direct[\s\S]*?Decision · Cass Consultant · 22\/10\/2026 · <q>No direct emissions<\/q>/);
    assert.match(html, /Stationary combustion[\s\S]*?Hidden by its scope/);
    assert.match(html, /Business travel[\s\S]*?>Hidden<[\s\S]*?>Show</);
    assert.match(html, /Employee commuting[\s\S]*?>Shown<[\s\S]*?>Hide</);
    assert.match(html, /Category visibility already applies in the client(?:&#x27;|')s portal\. The other settings are recorded and explained now/);
  });

  it("a member of staff without the capability sees the settings but cannot change them, and is told why", () => {
    const html = body({ profileAccess: { state: "denied", reason: "Your role does not include portal administration." } });
    assert.match(html, /You can see portal settings but not change them: Your role does not include portal administration\./);
    assert.match(html, /aria-label="Time"[^]*?aria-disabled="true"/);
  });

  it("loading, refused and failed are three different things, never an empty profile", () => {
    assert.match(body({ load: { state: "loading" } }), /Loading this client(?:&#x27;|')s portal profile/);
    assert.match(body({ load: { state: "denied" } }), /it needs portal\.admin/);
    assert.match(body({ load: { state: "failed" } }), /could not be loaded\. Nothing is shown rather than a profile that might be wrong/);
    for (const state of ["loading", "denied", "failed"] as const) assert.doesNotMatch(body({ load: { state } }), />Return to default<|aria-pressed/);
  });

  it("each control sends its own governed command, through its own route", () => {
    const source = read("apps/console/app/clients/[clientId]/PortalManagementArea.tsx");
    assert.match(source, /onSend\(entry\.key, "\/portal-profile", \{ profileKey: entry\.key, value \}/);
    assert.match(source, /onSend\(entry\.key, "\/portal-profile", \{ profileKey: entry\.key, value: null \}/);
    assert.match(source, /"\/portal-profile\/scopes", \{ scope: scope\.scope, visible \}/);
    assert.match(source, /"\/category-visibility", \{ categoryCode: category\.categoryCode, visible: !on \}/);
    const routes = "apps/console/app/api/isolated/clients/[clientId]";
    assert.match(read(`${routes}/portal-profile/route.ts`), /requireCommandPrincipal\(request, "client\.portal\.profile\.set"\)/);
    assert.match(read(`${routes}/portal-profile/route.ts`), /getPortalProfileForStaff\(isolatedPool\(\), principal, clientId\)/);
    assert.match(read(`${routes}/portal-profile/scopes/route.ts`), /requireCommandPrincipal\(request, "client\.portal\.scope\.visibility\.set"\)/);
    assert.match(read(`${routes}/category-visibility/route.ts`), /requireCommandPrincipal\(request, "client\.category\.visibility\.set"\)/);
  });

  it("the staff preview explains how this client's portal differs from the default — and says when it does not", async () => {
    const { PortalPreview } = await import("../app/clients/[clientId]/portal-preview/PortalPreview");
    const preview = (profile: PortalProfileStaffView) => renderToStaticMarkup(createElement(PortalPreview, { preview: {
      client: { id: "client-a", name: "Client A" }, previewedAt: "2026-10-22T09:00:00.000Z", profile,
      strategies: { state: "empty" } as never, readiness: { state: "empty" } as never,
    } }));
    const differs = preview(VIEW);
    assert.match(differs, /Staff only — this client(?:&#x27;|’|&rsquo;)s portal profile\./);
    for (const line of ["Time: Shown (default Hidden)", "Scope 1 — direct: hidden, with every category in it", "Business travel: hidden"]) assert.ok(differs.includes(line), line);
    const plain: PortalProfileStaffView = { clientId: "c", profile: VIEW.profile.map((entry) => ({ ...entry, effectiveValue: entry.defaultValue, decision: null })), scopes: VIEW.scopes.map((scope) => ({ ...scope, effectiveVisible: true, decision: null, categories: [] })) };
    assert.match(preview(plain), /It is your organisation(?:&#x27;|')s default: nothing has been decided differently for this client\./);
  });

  it("History says each decision in words", () => {
    const history = read("apps/console/app/clients/[clientId]/HistoryArea.tsx");
    for (const action of ["client_portal_profile_set", "client_portal_scope_visibility_set", "client_category_visibility_set"]) assert.ok(history.includes(`/^${action}$/`), action);
  });
});
