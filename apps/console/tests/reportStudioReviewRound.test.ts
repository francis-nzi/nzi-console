import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { staffMayEditNarrative, type ReportComposition } from "@nzi/contracts";
import type { StaffReportThread } from "@nzi/isolated-backend";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
(globalThis as { React?: unknown }).React = React;

// F1: the Report Studio opens a round in client review (and, read-only, one the client has approved). Display and wiring only - every control it
// offers is an existing command behind its own gate; nothing new on the backend.
describe("the studio opens a client-review round (F1)", async () => {
  const studio = await import("../app/jobs/[jobId]/report/studio");
  const { ReportStudioPrinting } = await import("../app/jobs/[jobId]/report/ReportStudio");
  const row = (id: string, status: string, createdAt: string, jobId = "j1") =>
    ({ reportVersionId: id, jobId, status, createdAt, publishedAt: status === "published" ? createdAt : null, scopeLabel: "Whole client", version: 3, manifestVersion: 1, snapshotId: `snap-${id}` }) as never;

  it("opens the newest round whatever its review status - and still never a superseded or draft one, or another job's", () => {
    const register = [row("r1", "published", "2026-10-01T09:00:00Z"), row("r2", "in_client_review", "2026-10-10T09:00:00Z"), row("r3", "superseded", "2026-10-12T09:00:00Z"),
      row("r4", "draft", "2026-10-13T09:00:00Z"), row("x", "in_client_review", "2026-10-14T09:00:00Z", "j2")];
    assert.deepEqual([studio.pickStudioVersion(register, "j1")?.reportVersionId, studio.pickStudioVersion(register, "j1")?.status], ["r2", "in_client_review"]);
    assert.equal(studio.pickStudioVersion([row("a", "client_approved", "2026-10-10T09:00:00Z")], "j1")?.status, "client_approved");
    assert.equal(studio.pickStudioVersion(register, "j1", "x")?.reportVersionId, "r2", "another job's round is never opened here");
    assert.equal(studio.pickStudioVersion(register, "j1", "r1")?.status, "published", "an earlier round can still be asked for by id");
  });

  it("the plan rail belongs to a draft and a validated version; the narrative is amendable exactly where the staff allow-list says so", () => {
    assert.deepEqual((["draft", "validated", "in_client_review", "client_approved", "published"] as const).map(studio.studioPlanEditable), [true, true, false, false, false]);
    assert.deepEqual((["in_client_review", "client_approved", "validated", "published", "draft"] as const).map(studio.studioIsReviewRound), [true, true, false, false, false]);
    assert.equal(staffMayEditNarrative("in_client_review"), true);
    assert.equal(staffMayEditNarrative("client_approved"), false);
  });

  it("says where a round stands", () => {
    assert.equal(studio.studioStatusText("in_client_review", null), "In client review — not issued");
    assert.match(studio.studioStatusText("client_approved", null), /awaiting final approval/);
    assert.equal(studio.studioStatusText("published", "12 Oct 2026"), "Published 12 Oct 2026");
  });

  const composition = () => JSON.parse(fixture("composition-composed5-whole.json")) as ReportComposition;
  const base = { reportVersionId: "rv-9", createdAt: "2026-10-15T09:00:00Z", publishedAt: null, scopeLabel: "Whole client", version: 4, manifestVersion: 1, snapshotId: "snap-9" };
  const draw = (status: "in_client_review" | "client_approved") => renderToStaticMarkup(createElement(ReportStudioPrinting, { jobId: "712", version: { ...base, status }, composition: composition() }));

  it("draws an in-review round: marked as such, no validate or publish, the plan fixed - and the thread panel and edit history beside it", () => {
    const html = draw("in_client_review");
    assert.match(html, /data-studio-status="in_client_review"/);
    assert.match(html, /data-report-round="in_client_review"/);
    assert.match(html, /In client review — not issued/);
    assert.doesNotMatch(html, /data-studio-publish|data-studio-validate|data-studio-signee|data-studio-save/);
    assert.match(html, /This round is with the client: its sections are fixed\./);
    for (const tag of html.match(/<button[^>]*role="switch"[^>]*>/g) ?? []) assert.match(tag, /disabled=""/, "no rail switch is live");
    for (const tag of html.match(/<button[^>]*aria-label="Move [^>]*>/g) ?? []) assert.match(tag, /disabled=""/, "no rail move is live");
  });

  it("draws a client-approved round read-only, with the reason", () => {
    const html = draw("client_approved");
    assert.match(html, /data-report-round="client_approved"/);
    assert.match(html, /read-only: reopen the report to change it/);
    assert.doesNotMatch(html, /amend the narrative here/);
    assert.doesNotMatch(html, /data-studio-publish|data-studio-validate/);
  });

  it("the studio wires the existing controls to the round: narrative amend through report.narrative.update, restore, history, and the thread", () => {
    const source = read("apps/console/app/jobs/[jobId]/report/ReportStudio.tsx");
    assert.match(source, /version && staffMayEditNarrative\(kind\)/, "the amend target follows the staff allow-list, not a status list of the studio's own");
    assert.match(source, /<ReportRoundThread reportVersionId=\{version\.reportVersionId\} \/>/);
    assert.match(source, /studioIsReviewRound\(kind\) \?/);
    assert.match(read("apps/console/app/jobs/[jobId]/report/ReportVersionChain.tsx"), /staffMayEditNarrative\(current\.status\)/, "Restore lights up on the same allow-list");
    const page = read("apps/console/app/jobs/[jobId]/report/printing/page.tsx");
    assert.match(page, /version\.status === "published"/);
    assert.match(page, /: await loadScreen<Composed>\("reportCompositionPreview"/, "only an issued version reads its frozen composition; a round is composed live, read-only");
  });

  it("the thread panel reads and replies only through the inbox's own staff route, for this one round, and writes nothing else", () => {
    const panel = read("apps/console/app/jobs/[jobId]/report/ReportRoundThread.tsx");
    assert.equal((panel.match(/\/api\/isolated\/reports\/review-messages/g) ?? []).length, 2, "one read, one reply");
    assert.doesNotMatch(panel, /postBrowserCommand|\/api\/portal\//);
    assert.match(panel, /reportVersionId, body \}/, "a reply names the round it answers");
  });

  it("picks this round's thread out of the inbox read, and nothing for a round it does not list", async () => {
    const { threadOfRound } = await import("../app/jobs/[jobId]/report/roundThread");
    const threads = [{ reportVersionId: "a" }, { reportVersionId: "b" }] as StaffReportThread[];
    assert.equal(threadOfRound(threads, "b")?.reportVersionId, "b");
    assert.equal(threadOfRound(threads, "z"), null);
    assert.equal(threadOfRound(null, "a"), null);
  });
});
