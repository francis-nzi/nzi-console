import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { attachmentState, PORTAL_MESSAGE_MAX_ATTACHMENTS, type PortalMessageAttachment } from "@nzi/contracts";

/**
 * Message attachments in the UI and routes (RULING-portal-messages, M3): what a reader is told about each state, that only an available file has a
 * Download, that no storage identifier or URL is drawn, and that the whole surface is dark unless Conversations, Files and the attachments token are
 * all on - off, a message is text only and a multipart request is a 404. (The gate and the tenancy are proved against a real database in
 * isolated-backend `portalMessageAttachmentsReal`.)
 */
(globalThis as { React?: unknown }).React = React;
const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(resolve(here, "..", path), "utf8");
const attachment = (state: PortalMessageAttachment["state"], over: Partial<PortalMessageAttachment> = {}): PortalMessageAttachment => ({ fileId: `f-${state}`, fileName: `${state}.pdf`, contentType: "application/pdf", sizeBytes: 2048, state, ...over });

describe("attachment states", () => {
  it("only a released file is available; a held one is scanning, a refused one blocked, a withdrawn one withdrawn", () => {
    assert.deepEqual((["released", "quarantined", "rejected", "deactivated"] as const).map(attachmentState), ["available", "scanning", "blocked", "withdrawn"]);
    assert.equal(PORTAL_MESSAGE_MAX_ATTACHMENTS, 5);
  });
});

describe("the attachment list", () => {
  it("offers Download on an available file only, and says in words what the others are - no scanner detail, no URL, no storage id", async () => {
    const { AttachmentList } = await import("../app/lib/MessageAttachments");
    const html = renderToStaticMarkup(createElement(AttachmentList, {
      attachments: [attachment("available"), attachment("scanning"), attachment("blocked"), attachment("withdrawn")], downloadPath: (id: string) => `/x/${id}/download`,
    }));
    assert.equal((html.match(/>Download</g) ?? []).length, 1, "one Download, for the available file");
    assert.match(html, /aria-label="Download available\.pdf"/);
    assert.match(html, /Being checked — it can’t be downloaded until it has passed/);
    assert.match(html, /Blocked — it did not pass the checks and was not shared/);
    assert.match(html, /Withdrawn/);
    assert.doesNotMatch(html, /href=|https?:|external|sha256|infected|virus/i);
  });
  it("draws nothing for a message with no attachments", async () => {
    const { AttachmentList } = await import("../app/lib/MessageAttachments");
    assert.equal(renderToStaticMarkup(createElement(AttachmentList, { attachments: [], downloadPath: () => "" })), "");
  });
});

describe("the attachments flag", () => {
  const withFlags = async (tokens: string, run: () => Promise<void> | void) => {
    const previous = process.env.NEXT_PUBLIC_FEATURE_PORTAL;
    process.env.NEXT_PUBLIC_FEATURE_PORTAL = tokens;
    try { await run(); } finally { if (previous === undefined) delete process.env.NEXT_PUBLIC_FEATURE_PORTAL; else process.env.NEXT_PUBLIC_FEATURE_PORTAL = previous; }
  };
  it("is on only when portal-conversations, portal-files and portal-message-attachments are all on - and the picker draws nothing otherwise", async () => {
    const { attachmentsOn, AttachmentPicker } = await import("../app/lib/MessageAttachments");
    for (const [tokens, expected] of [["", false], ["portal-conversations", false], ["portal-conversations,portal-files", false], ["portal-message-attachments", false], ["portal-files,portal-message-attachments", false],
      ["portal-conversations,portal-files,portal-message-attachments", true]] as const) {
      await withFlags(tokens, () => {
        assert.equal(attachmentsOn(), expected, tokens);
        assert.equal(renderToStaticMarkup(createElement(AttachmentPicker, { files: [], onChange: () => undefined })).includes("Attach files"), expected, tokens);
      });
    }
  });
});

describe("message notifications: the portal side of the deep link", () => {
  it("a notification email opens the conversation it names: the lane reads ?thread= and lets the list decide whether the user may see it", () => {
    const lane = read("app/portal/messages/PortalConversations.tsx");
    assert.ok(lane.includes('new URLSearchParams(window.location.search).get("thread")'));
    assert.ok(lane.includes("pickThread(body.threads as PortalThreadSummary[], keep ?? previous)"), "an unknown or unseen id falls back to the user's own list");
  });
  it("the worker part is switched on only by the deployment", () => {
    const script = read("../../packages/isolated-backend/scripts/reminder-worker.ts");
    assert.match(script, /messageNotifications: process.env.NZI_PORTAL_MESSAGE_EMAIL === "on"/);
  });
});

describe("the message routes", () => {
  const routes = [
    "app/api/portal/threads/route.ts", "app/api/portal/threads/[threadId]/route.ts",
    "app/api/isolated/clients/[clientId]/threads/route.ts", "app/api/isolated/clients/[clientId]/threads/[threadId]/route.ts",
  ];
  it("each takes a message as JSON or a multipart form, through readMessageRequest and recordWithAttachments, and answers the file gate's own failures", () => {
    for (const route of routes) {
      const source = read(route);
      assert.match(source, /readMessageRequest\(/, route);
      assert.match(source, /recordWithAttachments\(/, route);
      assert.match(source, /uploadFailure\(error\)/, route);
    }
  });
  it("a multipart request needs the whole gate to be on (404 otherwise), reads the thread before storing a byte, and withdraws copies it did not record", () => {
    const form = read("app/lib/messageForm.ts");
    assert.match(form, /portalFeatureEnabled\("portal-conversations"\) && portalFeatureEnabled\("portal-files"\) && portalFeatureEnabled\("portal-message-attachments"\)/);
    assert.match(form, /if \(!attachmentsEnabled\(\)\) throw new FilesOffError\(\)/);
    assert.match(form, /ingestFile\(/);
    assert.match(form, /outcome\.replayed\) await withdrawAll/);
    assert.match(form, /catch \(error\) \{ await withdrawAll\(message\.adapter, message\.ingests\); throw error; \}/);
    assert.match(read("app/api/portal/threads/[threadId]/route.ts"), /jobIdFor: async \(\) => \(await getPortalThread\(/, "the portal route reads the thread (and so refuses an unseen one) before any file is stored");
    assert.match(read("app/api/isolated/clients/[clientId]/threads/[threadId]/route.ts"), /jobIdFor: async \(\) => \(await getClientThread\(/);
  });
  it("downloads reuse the existing audited file routes - no new storage path", () => {
    assert.match(read("app/portal/messages/PortalConversations.tsx"), /\/api\/portal\/files\/\$\{encodeURIComponent\(fileId\)\}\/download/);
    assert.match(read("app/clients/[clientId]/PortalConversationsPanel.tsx"), /\/api\/isolated\/clients\/\$\{encodeURIComponent\(clientId\)\}\/files\/\$\{encodeURIComponent\(fileId\)\}\/download/);
  });
});
