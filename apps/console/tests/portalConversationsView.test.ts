import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PortalThreadSummary } from "@nzi/contracts";
import {
  clientAuthorLabel, clientStateLabel, filterBySubject, isSubjectList, isThreadDetail, isThreadList, pickThread, STAFF_STATE_LABEL, targetNote,
} from "../app/portal/messages/conversationsModel";

/**
 * The Conversations lane (RULING-portal-messages, M1): how a thread's state, target and authors are worded, the checks a route's answer
 * passes before it is drawn, and that the whole surface is dark behind `portal-conversations` - off, Messages is the report thread it has been.
 * What a user may see is the server's decision (proved against a real database in isolated-backend `portalConversationsReal`).
 */
(globalThis as { React?: unknown }).React = React;
const components = async () => ({ ...(await import("../app/portal/messages/PortalConversations")), ...(await import("../app/portal/messages/MessagesView")) });
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const routes = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? routes(path) : name === "route.ts" ? [path] : []; });

const thread = (over: Partial<PortalThreadSummary> = {}): PortalThreadSummary => ({
  threadId: "t1", clientId: "c1", scope: "job", jobId: "j1", jobNumber: "J000612", subjectCode: "data", subjectLabel: "Data", title: "Gas bills", state: "awaiting_nzi", reportVersionId: null,
  messageCount: 2, lastMessageAt: "2026-10-05T09:00:00.000Z", createdAt: "2026-10-01T09:00:00.000Z", responseTargetAt: "2026-10-07T09:00:00.000Z", unread: 0, ...over,
});

describe("the Conversations lane", () => {
  it("words the state for the client in the organisation's own name, and for staff plainly", () => {
    assert.equal(clientStateLabel("awaiting_nzi", "Net Zero International"), "Awaiting Net Zero International");
    assert.equal(clientStateLabel("awaiting_nzi", "your adviser"), "Awaiting your adviser");
    assert.deepEqual((["awaiting_client", "resolved", "open"] as const).map((state) => clientStateLabel(state, "x")), ["Awaiting you", "Resolved", "Open"]);
    assert.deepEqual(STAFF_STATE_LABEL, { open: "Open", awaiting_nzi: "Awaiting adviser", awaiting_client: "Awaiting client", resolved: "Resolved" });
    assert.equal(clientAuthorLabel("you", "Net Zero International"), "You");
    assert.equal(clientAuthorLabel("colleague", "Net Zero International"), "A colleague");
    assert.equal(clientAuthorLabel("adviser", "Net Zero International"), "Net Zero International");
  });

  it("surfaces the response target as a dd/mm/yyyy date to look at - only while the client waits, never as a countdown", () => {
    assert.equal(targetNote(thread(), "client", "your adviser"), "A reply from your adviser is expected by 07/10/2026");
    assert.equal(targetNote(thread(), "staff"), "Reply target 07/10/2026");
    for (const state of ["open", "awaiting_client", "resolved"] as const) assert.equal(targetNote(thread({ state, responseTargetAt: null }), "client"), null, state);
    assert.equal(targetNote(thread({ responseTargetAt: null }), "client"), null);
  });

  it("opens the thread with something unread first, keeps the current one, and filters by subject tag", () => {
    const list = [thread({ threadId: "a", unread: 0 }), thread({ threadId: "b", unread: 2, subjectCode: "reports" }), thread({ threadId: "c" })];
    assert.equal(pickThread(list, null), "b");
    assert.equal(pickThread(list, "c"), "c");
    assert.equal(pickThread(list, "gone"), "b");
    assert.equal(pickThread([], null), null);
    assert.deepEqual(filterBySubject(list, "reports").map((t) => t.threadId), ["b"]);
    assert.equal(filterBySubject(list, "all").length, 3);
  });

  it("verifies what a route answers before drawing it: a malformed answer is a failure, not an empty list", () => {
    assert.equal(isThreadList([thread()]), true);
    assert.equal(isThreadList([]), true);
    assert.equal(isThreadList([{ ...thread(), state: "nonsense" }]), false);
    assert.equal(isThreadList(undefined), false);
    assert.equal(isSubjectList([{ code: "data", label: "Data", sortOrder: 10, active: true }]), true);
    assert.equal(isSubjectList([{ code: 1 }]), false);
    assert.equal(isThreadDetail({ thread: thread(), messages: [{ messageId: "m", seq: 1, body: "hi", createdAt: "2026-10-01T09:00:00Z", author: "you", authorPrincipal: "portal" }] }), true);
    assert.equal(isThreadDetail({ thread: thread(), messages: [{ body: "no id" }] }), false);
  });

  it("draws the list and the conversation lane for the client, naming the organisation as its profile does", async () => {
    const { PortalConversations } = await components();
    const html = renderToStaticMarkup(createElement(PortalConversations, { jobId: "j1" }));
    assert.match(html, /Loading your conversations/);
    const source = read("app/portal/messages/PortalConversations.tsx");
    assert.match(source, /useOrganisationName\(\)/);
    assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""), /\bNZI\b(?![-_])/, "D3b: the organisation is named from its profile, never typed");
    assert.match(source, /postBrowserCommand<\{ threadId: string \}>\(api, \{ jobId: form\.wholeOrganisation \? null : jobId,/, "a conversation is on this job, or for the whole organisation");
    assert.match(source, /\/read`, \{\}, crypto\.randomUUID\(\)/, "reading is the audited command");
    assert.doesNotMatch(source, /staff-|authorName|userId/, "no staff name or id reaches the client's view");
    assert.match(source, /formatDateTime\(message\.createdAt\)/, "dd/mm/yyyy (NZC-040)");
  });

  it("is dark behind portal-conversations: off, and in the staff preview, Messages is the report thread it has been", async () => {
    const view = read("app/portal/messages/MessagesView.tsx");
    assert.match(view, /portalFeatureEnabled\("portal-conversations"\) && !surface\.readOnly \? <PortalConversations jobId=\{jobId\} \/> : <PortalMessages jobId=\{jobId\} \/>/);
    assert.match(read("app/portal/jobs/[jobId]/messages/page.tsx"), /<MessagesView jobId=\{jobId\} \/>/);
    assert.match(read("app/clients/[clientId]/portal-preview/jobs/[jobId]/messages/page.tsx"), /PortalMessages/, "the staff preview is unchanged");
    const panelSlot = read("app/clients/[clientId]/PortalManagementArea.tsx");
    assert.match(panelSlot, /messages=\{portalFeatureEnabled\("portal-conversations"\) \? <PortalConversationsPanel clientId=\{clientId\} access=\{profileAccess\} \/> : null\}/);
  });

  it("puts every conversation route behind the flag first (404 while off), and every write behind the audited command and, for a client, the origin and session checks", () => {
    const all = [...routes(resolve(root, "app/api/portal/threads")), ...routes(resolve(root, "app/api/isolated/clients/[clientId]/threads")), resolve(root, "app/api/isolated/thread-subjects/route.ts")];
    assert.equal(all.length, 6);
    for (const path of all) {
      const text = readFileSync(path, "utf8");
      for (const verb of text.matchAll(/export async function (GET|POST|PATCH)[\s\S]*?\n}\n/g)) assert.match(verb[0], /try \{\s+requireConversations\(\);/, `${path} ${verb[1]}`);
      if (path.includes(`${"portal"}${"\\"}threads`) || path.includes("portal/threads")) for (const verb of text.matchAll(/export async function POST[\s\S]*?\n}\n/g)) assert.match(verb[0], /requirePortalOrigin\(request\)/, path);
    }
    assert.match(read("app/api/isolated/clients/[clientId]/threads/[threadId]/route.ts"), /requireCommandPrincipal\(request, "client\.thread\.update"\)/);
    assert.match(read("app/api/isolated/thread-subjects/route.ts"), /requireCommandPrincipal\(request, "thread_subject\.set"\)/);
  });
});
