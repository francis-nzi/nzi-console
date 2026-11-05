// Portal Management → Access in the console (RULING-portal-access-model): the tab replaces the old "Portal access" drawer; it shows the
// record or the defaults (payment "—", never "Unpaid"), saves only what changed, asks before a switch-off or an already-passed expiry,
// and the login routes hand the request's network data to the event record. The enforcement and the log are `portalAccessEnforcementReal`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { portalClientAccessDefaults, type PortalClientAccess, type PortalClientAccessView } from "@nzi/contracts";
import type * as TabModule from "../app/clients/[clientId]/PortalAccessTab";

(globalThis as { React?: unknown }).React = React;
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
let mod: typeof TabModule;
before(async () => { mod = await import("../app/clients/[clientId]/PortalAccessTab"); });

const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const view = (over: Partial<PortalClientAccess> = {}): PortalClientAccessView => ({
  access: { ...portalClientAccessDefaults("client-a"), ...over }, activeUsers: 3,
  decisions: [{ decisionId: "d1", field: "enabled", from: true, to: false, note: "Contract ended", changedBy: "sam", changedByName: "Sam Staff", changedAt: "2026-10-30T09:00:00.000Z" }],
  loginEvents: [{ eventId: "e1", occurredAt: "2026-11-01T09:00:00.000Z", outcome: "client_disabled", portalUserId: "grace", userName: "Grace A", ip: "203.0.113.9", userAgent: "Mozilla/5.0 test" }],
});
const render = (v: PortalClientAccessView, extra: Partial<Parameters<typeof TabModule.PortalAccessBody>[0]> = {}) => renderToStaticMarkup(createElement(mod.PortalAccessBody, {
  load: { state: "ready", view: v }, access: { state: "allowed" }, onRetry: () => undefined, onSave: async () => ({ ok: true as const, sessionsEnded: 0 }), now: () => NOW, ...extra,
}));

describe("the Access tab", () => {
  it("shows a client with no record as the defaults: on, no expiry, no cap, payment — (never Unpaid)", () => {
    const html = render(view());
    assert.match(html, /Portal access · Active · No expiry set/);
    assert.match(html, /aria-checked="true"[^>]*aria-label="Enable portal access"/);
    assert.match(html, /aria-checked="false"[^>]*aria-label="Portal trained"/);
    assert.match(html, /<select[^>]*aria-label="Payment status"[^>]*>\s*<option value="" selected="">—<\/option>/);
    assert.doesNotMatch(html.slice(html.indexOf("Payment status"), html.indexOf("Payment / invoice")), /selected="">Unpaid/);
    assert.match(html, /placeholder="Unlimited"/);
    assert.match(html, /Informational cap; it does not block inviting\. 3 active\./);
    assert.match(html, /Master switch\. Off blocks every user for this client at sign-in and signs them out\./);
  });

  it("says Switched off or Expired in its status, and lists the decisions and (on request) the login history", () => {
    assert.match(render(view({ enabled: false, version: 1 })), /Portal access · Switched off · No expiry set/);
    assert.match(render(view({ expiresAt: "2026-10-01T09:00:00.000Z", version: 1 })), /Portal access · Expired · Expired /);
    const html = render(view({ version: 1 }));
    assert.match(html, /<b>Enable portal access<\/b>: On → Off[\s\S]*?Sam Staff[\s\S]*?<q>Contract ended<\/q>/);
    assert.doesNotMatch(html, /Refused — client switched off/, "the login history opens on request");
    assert.match(readFileSync(new URL("../app/clients/[clientId]/PortalAccessTab.tsx", import.meta.url), "utf8"), /Refused — client switched off/);
  });

  it("warns, before it is saved, about an expiry that has already passed", () => {
    assert.match(render(view({ expiresAt: "2026-10-01T09:00:00.000Z", version: 1 })), /That date has passed\. Saving it locks out every user of this client and signs them out now\./);
    assert.doesNotMatch(render(view({ expiresAt: "2027-01-01T09:00:00.000Z", version: 1 })), /That date has passed/);
    assert.doesNotMatch(render(view()), /That date has passed/);
  });

  it("sends only what changed, and none of it when nothing did", () => {
    const access = { ...portalClientAccessDefaults("client-a"), version: 2 };
    const draft = { enabled: true, trained: false, expires: "", userCap: "", paymentStatus: "" as const, paymentRef: "", notes: "" };
    assert.deepEqual(mod.accessChanges(access, draft), { changes: {} });
    assert.deepEqual(mod.accessChanges(access, { ...draft, enabled: false, userCap: "5", paymentStatus: "paid", paymentRef: " INV-1 ", notes: " hi " }),
      { changes: { enabled: false, userCap: 5, paymentStatus: "paid", paymentRef: "INV-1", notes: "hi" } });
    assert.deepEqual(mod.accessChanges(access, { ...draft, userCap: "-1" }), { error: "The number of users is a whole number, or blank." });
    assert.deepEqual(mod.accessChanges(access, { ...draft, expires: "not a date" }), { error: "That expiry isn't a valid date and time." });
    const cleared = mod.accessChanges({ ...access, expiresAt: "2027-01-01T09:00:00.000Z" }, draft);
    assert.deepEqual(cleared, { changes: { expiresAt: null } }, "blank clears the expiry");
  });

  it("asks before a switch-off or an already-passed expiry, and before nothing else", () => {
    assert.equal(mod.accessCutoff({ enabled: false }, NOW), "switch-off");
    assert.equal(mod.accessCutoff({ expiresAt: "2026-10-01T09:00:00.000Z" }, NOW), "past-expiry");
    assert.equal(mod.accessCutoff({ expiresAt: "2027-01-01T09:00:00.000Z" }, NOW), null);
    for (const changes of [{ enabled: true }, { trained: true }, { expiresAt: null }, { userCap: 3 }, { paymentStatus: "paid" as const }, { notes: "x" }]) assert.equal(mod.accessCutoff(changes, NOW), null, JSON.stringify(changes));
    const source = read("apps/console/app/clients/[clientId]/PortalAccessTab.tsx");
    assert.match(source, /if \(cutoff && !confirmed\) \{ setConfirming\(cutoff\); return; \}/, "a cut-off is never saved without the confirmation");
    assert.match(source, /Every user of this client is blocked at sign-in and signed out now/);
    assert.match(source, /Turn it back on to restore access; nobody needs re-inviting\./);
  });

  it("disables the controls for a member of staff without the capability, and says why", () => {
    const html = render(view(), { access: { state: "denied", reason: "Your role does not include portal administration." } });
    assert.match(html, /You can see portal access but not change it: Your role does not include portal administration\./);
    assert.match(html, /aria-label="Enable portal access"[^>]*aria-disabled="true"|aria-disabled="true"[^>]*aria-label="Enable portal access"/);
    assert.match(html, /<input[^>]*aria-label="Access expires at"[^>]*disabled=""/);
  });

  it("loading, refused and failed are three different things, never a default state", () => {
    const state = (load: Parameters<typeof TabModule.PortalAccessBody>[0]["load"]) => renderToStaticMarkup(createElement(mod.PortalAccessBody, { load, access: { state: "allowed" }, onRetry: () => undefined, onSave: async () => ({ ok: true as const, sessionsEnded: 0 }) }));
    assert.match(state({ state: "loading" }), /Loading this client(?:&#x27;|')s portal access/);
    assert.match(state({ state: "denied" }), /it needs portal\.admin/);
    assert.match(state({ state: "failed" }), /could not be loaded\. Nothing is shown rather than a state that might be wrong/);
    for (const load of [{ state: "loading" }, { state: "denied" }, { state: "failed" }] as const) assert.doesNotMatch(state(load), /role="switch"|Active/);
  });
});

describe("the old drawer is gone and the tab is wired", () => {
  it("has no Portal access drawer, and its openers open the Access tab (only for someone who may manage the portal)", () => {
    for (const file of ["ClientRecordDrawers.tsx", "ClientWorkspaceView.tsx", "clientDrawers.ts"]) assert.doesNotMatch(read(`apps/console/app/clients/[clientId]/${file}`), /PortalDrawerBody|kind: "portal"|Platform & audit/, file);
    const view = read("apps/console/app/clients/[clientId]/ClientWorkspaceView.tsx");
    // Portal Management sits under the Manage tab, so its openers open that tab.
    assert.match(view, /\{canManagePortal \? <button type="button" className="nz-btn" onClick=\{\(\) => selectTab\("manage"\)\}>Portal access<\/button> : null\}/);
    assert.match(view, /const openPortal = canManagePortal \? \(\) => selectTab\("manage"\) : undefined;/);
    assert.match(view, /onOpenPortal=\{openPortal\}/);
    for (const file of ["OverviewArea.tsx", "ProfileArea.tsx"]) assert.doesNotMatch(read(`apps/console/app/clients/[clientId]/${file}`), /kind: "portal"/, file);
  });

  it("opens Portal Management on Access, with the tab live", () => {
    const area = read("apps/console/app/clients/[clientId]/PortalManagementArea.tsx");
    assert.match(area, /useState<PortalManagementTab>\("access"\)/);
    assert.match(area, /new Set\(\["access", "visibility", "scopes"\]\)/);
    assert.match(area, /access=\{<PortalAccessTab clientId=\{clientId\} access=\{profileAccess\} \/>\}/);
  });

  it("reads and saves through one route, under the command's own permission", () => {
    const route = read("apps/console/app/api/isolated/clients/[clientId]/portal-client-access/route.ts");
    assert.match(route, /getClientPortalAccess\(isolatedPool\(\), principal, clientId\)/);
    assert.match(route, /requireCommandPrincipal\(request, "client\.portal\.access\.set"\)/);
    assert.match(route, /setClientPortalAccess\(isolatedPool\(\), \{ \.\.\.body, clientId \}/);
  });

  it("hands the request's address and browser to the login record, from both sign-in steps", () => {
    assert.match(read("apps/console/app/api/portal/auth/login/route.ts"), /startPortalLogin\(isolatedPool\(\),\{[^}]*\},new Date\(\),requestNetwork\(request\)\)/);
    assert.match(read("apps/console/app/api/portal/auth/mfa/route.ts"), /\},requestNetwork\(request\)\);/);
    const helper = read("apps/console/app/lib/requestNetwork.ts");
    assert.match(helper, /slice\(0, 64\)/);
    assert.match(helper, /slice\(0, 300\)/);
  });

  it("is run by CI: the enforcement suite has its own step", () => {
    assert.match(read(".github/workflows/ci.yml"), /npx tsx --test packages\/isolated-backend\/tests\/portalAccessEnforcementReal\.test\.ts/);
  });
});
