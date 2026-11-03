import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PortalNotice } from "@nzi/contracts";
import { actionHref, bellLabel, isNoticeFeed, isPortalNotice, newestAt, noticeText } from "../app/portal/messages/noticesModel";

/**
 * The Updates lane and the bell (RULING-portal-messages, M2): notices worded in the organisation's own name with dd/mm/yyyy dates, one action each
 * that never leads to a page that is switched off, an unread count on a bell that is on every shell page for the signed-in client only, and the whole
 * surface dark behind `portal-conversations`. What a user may see is the server's decision (proved against a real database in `portalNoticesReal`).
 */
(globalThis as { React?: unknown }).React = React;
const components = async () => ({ ...(await import("../app/portal/messages/PortalBell")), ...(await import("../app/portal/messages/PortalUpdatesFeed")), ...(await import("../app/portal/messages/MessagesView")) });
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const notice = (over: Partial<PortalNotice> = {}): PortalNotice => ({
  noticeKey: "report:rv1", kind: "report", at: "2026-10-18T09:00:00.000Z", subjectCode: "reports", subjectLabel: "Reports", jobId: "j1", jobNumber: "J000612",
  detail: { kind: "report", reportVersionId: "rv1", scopeLabel: null }, action: { label: "Review the report", view: "reports", path: "/portal/reports", externalUrl: null }, unread: true, ...over,
});
const link = (path: string) => path;

describe("the Updates lane", () => {
  it("words each notice from its facts, naming the organisation as its profile does and dating dd/mm/yyyy - and says nothing of money or a reviewer's words", () => {
    assert.equal(noticeText(notice(), "Net Zero International").title, "Your report for J000612 is ready to review");
    assert.match(noticeText(notice(), "Net Zero International").body!, /Net Zero International has published it/);
    assert.match(noticeText(notice(), "your adviser").body!, /your adviser has published it/);
    const sites = noticeText(notice({ detail: { kind: "report", reportVersionId: "rv1", scopeLabel: "selected sites" } }), "x");
    assert.match(sites.title, /\(selected sites\)/);
    assert.equal(noticeText(notice({ kind: "data", detail: { kind: "data", decision: "approved", count: 1 } }), "x").title, "An entry on J000612 was accepted");
    assert.equal(noticeText(notice({ kind: "data", detail: { kind: "data", decision: "approved", count: 12 } }), "x").title, "12 entries on J000612 were accepted");
    assert.equal(noticeText(notice({ kind: "data", detail: { kind: "data", decision: "rejected", count: 3 } }), "Net Zero International").title, "Net Zero International has questions about 3 entries on J000612");
    assert.equal(noticeText(notice({ kind: "deadline", detail: { kind: "deadline", closesOn: "2026-10-25" } }), "x").title, "Data entry for J000612 closes on 25/10/2026");
    const broadcast = noticeText(notice({ kind: "broadcast", jobId: null, jobNumber: null, detail: { kind: "broadcast", broadcastId: "b", title: "Planned maintenance", body: "Saturday morning.", style: "info" } }), "x");
    assert.deepEqual(broadcast, { title: "Planned maintenance", body: "Saturday morning." });
    for (const text of [noticeText(notice(), "x"), noticeText(notice({ kind: "deadline", detail: { kind: "deadline", closesOn: "2026-10-25" } }), "x")]) assert.doesNotMatch(JSON.stringify(text), /£|€|\$|fee|invoice/i);
  });

  it("gives each notice one action, and never one that leads to a view that is switched off for this client", () => {
    const all = new Set(["reports", "data"]);
    assert.deepEqual(actionHref(notice(), link, all), { label: "Review the report", href: "/portal/reports", external: false });
    assert.equal(actionHref(notice(), link, new Set(["data"])), null, "reports are not offered here, so the notice carries no dead link");
    const data = notice({ action: { label: "Open your data", view: "data", path: "/portal/jobs/j1/data", externalUrl: null } });
    assert.equal(actionHref(data, link, new Set(["reports"])), null);
    assert.equal(actionHref(data, () => null, all), null, "and none where the surface cannot reach it (the staff preview)");
    const external = notice({ action: { label: "Read more", view: null, path: null, externalUrl: "https://example.com/news" } });
    assert.deepEqual(actionHref(external, link, new Set()), { label: "Read more", href: "https://example.com/news", external: true });
    const internal = notice({ action: { label: "Open Files", view: null, path: "/portal/files", externalUrl: null } });
    assert.equal(actionHref(internal, link, new Set())?.href, "/portal/files");
    assert.equal(actionHref(notice({ action: null }), link, all), null, "a broadcast without a link has no action");
  });

  it("labels the bell from the unread count, and marks seen through the newest notice shown", () => {
    assert.deepEqual([0, 1, 9, 10, 250].map(bellLabel), [null, "1", "9", "9+", "9+"]);
    assert.equal(newestAt([notice({ at: "2026-10-01T00:00:00Z" }), notice({ at: "2026-10-18T09:00:00Z" }), notice({ at: "2026-10-10T00:00:00Z" })]), "2026-10-18T09:00:00Z");
    assert.equal(newestAt([]), null);
  });

  it("verifies what the route answers before drawing it: a malformed feed is a failure, not an empty one", () => {
    assert.equal(isPortalNotice(notice()), true);
    assert.equal(isPortalNotice({ ...notice(), kind: "nonsense" }), false);
    assert.equal(isPortalNotice({ ...notice(), kind: "data" }), false, "the detail must be of the notice’s own kind");
    assert.equal(isNoticeFeed({ notices: [notice()], unread: 1, seenThrough: null }), true);
    assert.equal(isNoticeFeed({ notices: [], unread: 0, seenThrough: "2026-10-18T09:00:00Z" }), true);
    assert.equal(isNoticeFeed({ notices: [{}], unread: 0, seenThrough: null }), false);
    assert.equal(isNoticeFeed(undefined), false);
  });

  it("draws the bell and the lane with nothing before the feed has loaded, and no reply control anywhere", async () => {
    const { PortalBell, PortalUpdatesFeed } = await components();
    const bell = renderToStaticMarkup(createElement(PortalBell));
    assert.match(bell, /aria-label="Updates"/);
    assert.doesNotMatch(bell, /nzp-bell-count|role="dialog"/, "no count before the feed is read, and closed until it is opened");
    assert.match(renderToStaticMarkup(createElement(PortalUpdatesFeed)), /Loading your updates/);
    for (const file of ["PortalUpdatesFeed.tsx", "PortalBell.tsx"]) assert.doesNotMatch(read(`app/portal/messages/${file}`).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""), /<textarea|<form|onSubmit|reply/i, "a notice is not a thread");
  });

  it("is on every shell page for the signed-in client - not the staff preview - and only behind portal-conversations", () => {
    const shell = read("app/portal/shell/PortalShell.tsx");
    assert.match(shell, /person\.kind === "client" && portalFeatureEnabled\("portal-conversations"\) \? <PortalBell \/> : null/);
    assert.match(shell, /<div className="nzp-utilbar">[\s\S]*<PortalBell \/>[\s\S]*<\/div>\s*<div className="nzp-content"/, "in the top bar of the one shell every portal view is framed in");
    assert.match(read("app/portal/messages/MessagesView.tsx"), /portalFeatureEnabled\("portal-conversations"\) && !surface\.readOnly\)\) return <PortalMessages jobId=\{jobId\} \/>/, "off: the report thread it has been");
    assert.match(read("app/portal/messages/MessagesView.tsx"), /Updates\{unread \? ` \(\$\{unread\}\)` : ""\}/);
  });

  it("has two read-only-ish routes behind the flag first: the feed (GET) and the audited seen marker (POST, origin and session checked)", () => {
    const feed = read("app/api/portal/notices/route.ts"), seen = read("app/api/portal/notices/seen/route.ts");
    assert.match(feed, /try \{\s+requireConversations\(\);/);
    assert.doesNotMatch(feed, /export async function (POST|PUT|PATCH|DELETE)/, "the feed is read-only");
    assert.match(seen, /try \{\s+requireConversations\(\);/);
    assert.match(seen, /requirePortalOrigin\(request\)/);
    assert.match(seen, /markPortalNoticesSeen\(/);
  });
});
