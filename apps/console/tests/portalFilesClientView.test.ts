import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PortalFileRecord } from "@nzi/contracts";
import {
  canDownload, filterByCategory, groupFiles, isPortalFileHistory, isPortalFileList, scanLabel, unavailableNote,
} from "../app/portal/files/portalFilesModel";

/**
 * The client Files view (RULING-portal-files-client-ui): grouped by direction and job, the scan state on the client's own uploads, no download
 * for anything not released, a category filter, the withdrawal reason - and dark behind `portal-files`, where the page is the preview it was.
 * What the client may see is the server's decision (proved in isolated-backend `portalFilesReal`); this proves what the page does with it.
 */
// Components are loaded after React is global (a module draws JSX as it loads), as the portal Data view tests load theirs.
(globalThis as { React?: unknown }).React = React;
const components = async () => ({ ...(await import("../app/portal/files/PortalFilesView")), ...(await import("../app/portal/files/FilesPreview")) });
const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(resolve(here, "..", path), "utf8");
const file = (over: Partial<PortalFileRecord> = {}): PortalFileRecord => ({
  fileId: "f1", clientId: "c1", jobId: "job-1", direction: "client_upload", status: "released", fileName: "Utility bills.xlsx", contentType: "application/pdf", sizeBytes: 2048,
  sha256: "a".repeat(64), flag: null, flagDetail: null, category: "data_evidence", uploadedBy: "You", uploadedByPrincipal: "portal", uploadedAt: "2026-10-01T09:00:00.000Z",
  releasedAt: "2026-10-01T09:00:01.000Z", deactivatedAt: null, deactivatedBy: null, deactivatedReason: null, ...over,
});
const titles: Record<string, string> = { "job-1": "J000612 · CRP 2026", "job-2": "J000613 · CRP 2025" };
const title = (jobId: string) => titles[jobId] ?? "Another job";

describe("the client Files view", () => {
  it("shows the scan state on the client's own uploads - Scanning, Clean, Quarantined - and on nobody else's", () => {
    assert.equal(scanLabel(file({ status: "quarantined", flag: "scan_inconclusive" })), "Scanning");
    assert.equal(scanLabel(file({ status: "released" })), "Clean");
    assert.equal(scanLabel(file({ status: "rejected", flag: "infected" })), "Quarantined");
    assert.equal(scanLabel(file({ uploadedBy: "A colleague" })), null, "a colleague's file is not theirs to read the scan of");
    assert.equal(scanLabel(file({ direction: "deliverable", uploadedByPrincipal: "staff", uploadedBy: "NZI" })), null);
    assert.equal(scanLabel(file({ status: "deactivated" })), null, "a withdrawn file's state is the withdrawal");
  });

  it("offers a download only for a released file; held, refused and withdrawn files say why instead", () => {
    assert.equal(canDownload(file({ status: "released" })), true);
    for (const status of ["quarantined", "rejected", "deactivated"] as const) assert.equal(canDownload(file({ status })), false, status);
    assert.match(unavailableNote(file({ status: "quarantined" }), "your adviser")!, /Being checked/);
    assert.match(unavailableNote(file({ status: "rejected", flag: "infected" }), "your adviser")!, /Quarantined.*A virus was found/);
    assert.equal(unavailableNote(file({ status: "released" }), "your adviser"), null);
  });

  it("shows the client why staff withdrew their file, in the organisation's own name", () => {
    const withdrawn = file({ status: "deactivated", deactivatedAt: "2026-10-02T09:00:00.000Z", deactivatedReason: "Uploaded to the wrong job" });
    assert.equal(unavailableNote(withdrawn, "Net Zero International"), "Withdrawn by Net Zero International: Uploaded to the wrong job");
    assert.equal(unavailableNote({ ...withdrawn, deactivatedReason: null }, "your adviser"), "Withdrawn by your adviser");
  });

  it("groups the two directions - From you, then From the adviser - each by job, client-wide files under All jobs, an empty group not drawn", () => {
    const files = [
      file({ fileId: "a", jobId: "job-2" }), file({ fileId: "b", jobId: "job-1" }), file({ fileId: "c", jobId: "job-1" }),
      file({ fileId: "d", direction: "deliverable", uploadedByPrincipal: "staff", uploadedBy: "NZI", jobId: null }),
      file({ fileId: "e", direction: "deliverable", uploadedByPrincipal: "staff", uploadedBy: "NZI", jobId: "job-1" }),
    ];
    const groups = groupFiles(files, title, "Net Zero International");
    assert.deepEqual(groups.map((group) => group.heading), ["From you", "From Net Zero International"]);
    assert.deepEqual(groups[0]!.jobs.map((job) => [job.heading, job.files.map((f) => f.fileId)]), [["J000612 · CRP 2026", ["b", "c"]], ["J000613 · CRP 2025", ["a"]]]);
    assert.deepEqual(groups[1]!.jobs.map((job) => [job.heading, job.files.map((f) => f.fileId)]), [["All jobs", ["d"]], ["J000612 · CRP 2026", ["e"]]]);
    assert.deepEqual(groupFiles([file()], title, "your adviser").map((group) => group.heading), ["From you"], "nothing from the adviser: that group is not drawn");
    assert.deepEqual(groupFiles([], title, "your adviser"), []);
  });

  it("filters by the fixed category set, and All shows everything", () => {
    const files = [file({ fileId: "a", category: "data_evidence" }), file({ fileId: "b", category: "reports" }), file({ fileId: "c", category: "contracts" }), file({ fileId: "d", category: "other" })];
    assert.deepEqual(filterByCategory(files, "all").map((f) => f.fileId), ["a", "b", "c", "d"]);
    for (const [category, id] of [["data_evidence", "a"], ["reports", "b"], ["contracts", "c"], ["other", "d"]] as const) assert.deepEqual(filterByCategory(files, category).map((f) => f.fileId), [id]);
  });

  it("verifies what the route answers before drawing it: a malformed list is a failure, not an empty one", () => {
    assert.equal(isPortalFileList([file()]), true);
    assert.equal(isPortalFileList([]), true);
    assert.equal(isPortalFileList([{ ...file(), category: "invoices" }]), false);
    assert.equal(isPortalFileList("nope"), false);
    assert.equal(isPortalFileList(undefined), false);
    assert.equal(isPortalFileHistory([{ at: "2026-10-01T09:00:00Z", who: "you", action: "uploaded", detail: null }]), true);
    assert.equal(isPortalFileHistory([{ who: "you" }]), false);
  });

  it("draws the dropzone and documents layout, and nothing in the table before the files have loaded", async () => {
    const { PortalFilesView } = await components();
    const html = renderToStaticMarkup(createElement(PortalFilesView));
    assert.match(html, /Drag files here, or browse/);
    assert.match(html, /Choose files/);
    for (const label of ["Data &amp; evidence", "Reports", "Contracts", "Other"]) assert.ok(html.includes(label), label);
    assert.match(html, /Loading your documents/);
    assert.doesNotMatch(html, /<table/);
    assert.doesNotMatch(html, /Example|coming soon/i, "nothing is presented as a preview");
  });

  it("downloads through the signed-URL command only: no storage id or URL is drawn, no client delete, History is a read", () => {
    const source = read("app/portal/files/PortalFilesView.tsx");
    assert.match(source, /postBrowserCommand<\{ url: string \}>\(`\/api\/portal\/files\/\$\{encodeURIComponent\(file\.fileId\)\}\/download`/);
    assert.match(source, /window\.open\(result\.data\.url, "_blank", "noopener"\)/);
    assert.doesNotMatch(source, /href=\{[^}]*url|externalItemId|storageProvider|external_item_id/, "the URL is opened, never drawn or stored");
    assert.doesNotMatch(source, /\/deactivate|method: "DELETE"|>\s*(Delete|Withdraw)/, "client self-withdraw is deferred: no client control removes a file");
    assert.match(source, /\/api\/portal\/files\/\$\{encodeURIComponent\(file\.fileId\)\}\/history/);
    assert.match(source, /form\.set\("jobId", uploadJob\); form\.set\("category", uploadCategory\)/, "an upload names a job and a category");
    assert.match(source, /\{canDownload\(file\) \? <button/, "the download control exists only for a released file");
  });

  it("is dark behind portal-files: off, the page is the preview it has been; on, the real view", async () => {
    const { FilesPreview } = await components();
    const page = read("app/portal/files/page.tsx");
    assert.match(page, /portalFeatureEnabled\("portal-files"\) \? <PortalFilesView \/> : <FilesPreview \/>/);
    assert.match(page, /if \(!portalFeatureEnabled\("portal-shell"\)\) redirect\("\/portal"\)/, "the shell flag still gates the page");
    assert.match(renderToStaticMarkup(createElement(FilesPreview)), /Preview — coming soon/);
    assert.match(read("app/clients/[clientId]/portal-preview/files/page.tsx"), /FilesPreview/, "the staff preview of the page is unchanged");
    assert.match(read("app/api/portal/files/[fileId]/history/route.ts"), /try \{\s+requirePortalFiles\(\);/, "the history route is 404 while the flag is off");
  });
});
