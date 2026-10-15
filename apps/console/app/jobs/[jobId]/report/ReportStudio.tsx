"use client";

import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import { crpProfessionalManifest } from "@nzi/charts";
import {
  moveReportSection, reportSectionPlanOf, setReportSectionIncluded,
  type ReportComposition, type ReportScope, type ReportSectionPlan,
} from "@nzi/contracts";
import type { ReportDraftComposition } from "@nzi/isolated-backend";
import { jobCrumbs, workspaceCrumbs } from "../../../lib/crumbs";
import { formatDate, formatDateTime } from "../../../lib/formatDate";
import { useJobReportRow } from "../../../lib/useJobReportRow";
import { PrepareFrame } from "../../../report-preview/PrepareFrame";
import { ReportScopeSelector } from "../../../report-preview/ReportScopeSelector";
import { ReportComposedView } from "../../../reports/[versionId]/ReportComposedView";
import { samePlan, studioDraftQuery, studioRail, studioRailLegend, type StudioVersion } from "./studio";

/**
 * The Report Studio, to `REPORT-STUDIO-design-reference.html` — the job's report in the console's chrome, with its three
 * sub-pages, the section rail beside the composed document, and the view control.
 *
 * The document is the composed renderer drawing a composition — a version's frozen one (published), its B0 preview
 * (validated), or the job's draft (B2-2: no version yet) — unchanged, so every pinned renderer draws exactly as before; the
 * studio is chrome around it. The rail (B2-1) edits the plan from B2-2, only through the governed commands: before validation
 * the plan and scope travel with `report.validate`; a validated version's plan is saved with `report.sectionPlan.update`
 * (pinning the version publish will pin); a published version is fixed. The server judges every change as it always has —
 * the exclusion, single-year and R7 rules are unchanged.
 */
export type StudioPage = "preparation" | "printing" | "review";

export function studioHref(jobId: string, page: StudioPage = "printing"): string {
  return `/jobs/${encodeURIComponent(jobId)}/report/${page}`;
}

const PAGE_LABEL: Record<StudioPage, string> = { preparation: "Report Preparation", printing: "Report Printing", review: "Client Review" };

/** The studio's frame: the job's own trail ending in the sub-page, and the three sub-pages as tabs. */
export function ReportStudioFrame({ jobId, page, children }: { jobId: string; page: StudioPage; children: ReactNode }) {
  const row = useJobReportRow(jobId);
  const crumbs = row
    ? jobCrumbs({ id: row.jobId, number: row.jobNumber, clientId: row.clientId, client: row.client }, { label: PAGE_LABEL[page], href: studioHref(jobId, page) })
    : workspaceCrumbs("Reports", "/reports", { label: PAGE_LABEL[page], href: studioHref(jobId, page) });
  // Preparation and Client Review are today's surfaces — the validation gate on /report-preview and the review inbox on
  // /reports — until B2-6 brings them into the studio.
  const tabs: Array<{ page: StudioPage; href: string }> = [
    { page: "preparation", href: `/report-preview?jobId=${encodeURIComponent(jobId)}` },
    { page: "printing", href: studioHref(jobId, "printing") },
    { page: "review", href: "/reports" },
  ];
  return <PrepareFrame crumbs={crumbs}>
    <div className="nzs-studio">
      <nav className="nzs-subnav" aria-label="Report">
        {tabs.map((tab) => tab.page === page
          ? <span key={tab.page} className="nzs-subnav-item on" aria-current="page">{PAGE_LABEL[tab.page]}</span>
          : <Link key={tab.page} className="nzs-subnav-item" href={tab.href}>{PAGE_LABEL[tab.page]}</Link>)}
      </nav>
      {children}
    </div>
  </PrepareFrame>;
}

type ViewMode = "flow" | "page";

/** The job's draft — composed now from its latest approved snapshot with the rail's choice, stored nowhere (B2-2). */
export type StudioDraft = Omit<ReportDraftComposition, "composition">;

/**
 * Report Printing: the toolbar, the section rail and the composed document. `draft` is set when the job has no version yet;
 * otherwise the version's status decides what the rail may do.
 */
export function ReportStudioPrinting({ jobId, version, composition, draft }: {
  jobId: string; version: StudioVersion | null; composition: ReportComposition; draft?: StudioDraft;
}) {
  const [mode, setMode] = useState<ViewMode>("flow");
  const stage = useRef<HTMLDivElement | null>(null);
  const kind: "draft" | "validated" | "published" = draft || !version ? "draft" : version.status;
  // The plan the document draws, and the plan the rail is editing (they differ only while a validated version's change is unsaved).
  const drawnPlan = reportSectionPlanOf(composition);
  const [plan, setPlan] = useState<ReportSectionPlan>(drawnPlan);
  const [scope, setScope] = useState<ReportScope>(draft?.scope ?? composition.scope ?? { kind: "whole" });
  const [pending, setPending] = useState<"save" | "validate" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const editable = kind !== "published" && pending === null;
  const rail = studioRail(composition, plan);
  const dirty = kind === "validated" && !samePlan(plan, drawnPlan);
  const whole = scope.kind === "whole";

  // A draft is re-read with the rail's choice: the server composes the draft the studio shows, from the plan and scope in the
  // URL. A plan is carried once it has been chosen here (or was already), so validate otherwise applies its own fallbacks.
  const chosenPlan = (next: ReportSectionPlan) => draft?.planOrigin === "edited" || !samePlan(next, draft?.sectionPlan ?? drawnPlan) ? next : null;
  const redraft = (next: { plan: ReportSectionPlan; scope: ReportScope }) => {
    window.location.assign(`${studioHref(jobId)}${studioDraftQuery({ plan: chosenPlan(next.plan), scope: next.scope })}`);
  };
  const changePlan = (next: ReportSectionPlan) => {
    if (!editable) return;
    setPlan(next);
    setMessage(null);
    if (kind === "draft") redraft({ plan: next, scope });
  };
  const changeScope = (next: ReportScope) => {
    if (kind !== "draft" || pending) return;
    setScope(next);
    // "By site" with no site chosen yet stays here, unread, until a site is picked (validate would refuse it).
    if (next.kind === "whole" || next.siteIds.length > 0) redraft({ plan, scope: next });
  };

  async function savePlan() {
    if (kind !== "validated" || !version || !dirty || pending) return;
    setPending("save");
    // report.sectionPlan.update pins the version this screen opened, so a version that moved elsewhere is refused, not overwritten.
    const result = await postBrowserCommand<{ version: number }>("/api/isolated/reports/section-plan",
      { reportVersionId: version.reportVersionId, expectedVersion: version.version, sectionPlan: plan }, crypto.randomUUID());
    setPending(null);
    if (result.state === "success") { window.location.reload(); return; }
    setMessage(result.state === "validation_failed" ? result.issues?.map((issue) => issue.message).join(" ") || result.message || "The section plan was not saved." : result.message || "The section plan was not saved.");
  }

  async function validate() {
    if (kind !== "draft" || !draft || draft.blockers.length > 0 || pending) return;
    setPending("validate");
    // The plan and scope on screen — the plan sent only when it was chosen here, so validate otherwise applies the client's
    // report profile, else the default, exactly as the draft shows.
    const result = await postBrowserCommand<{ reportVersionId: string }>("/api/isolated/reports/validate", {
      reviewedSnapshotId: draft.snapshotId, manifestVersion: crpProfessionalManifest.version, scope,
      ...(draft.planOrigin === "edited" ? { sectionPlan: plan } : {}),
    }, crypto.randomUUID());
    setPending(null);
    if (result.state === "success") { window.location.assign(`${studioHref(jobId)}?version=${encodeURIComponent(result.data.reportVersionId)}`); return; }
    setMessage(result.state === "validation_failed" ? result.issues?.map((issue) => issue.message).join(" ") || result.message || "Validation blocked." : result.message || "Validation failed.");
  }

  // The rail names a page by the heading the document gives it; the document itself is not touched (its markup is pinned).
  const goTo = (key: string, title: string) => {
    const root = stage.current;
    if (!root) return;
    const target = key === "cover"
      ? root.querySelector<HTMLElement>(".nzr-cover")
      : Array.from(root.querySelectorAll<HTMLElement>("section.nzr-page")).find((page) => page.querySelector("h2")?.textContent?.trim() === title) ?? null;
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const movable = rail.filter((row) => row.movable);
  const status = kind === "draft" ? "Draft — not validated, not issued" : kind === "validated" ? "Validated — preview, not issued"
    : `Published ${version?.publishedAt ? formatDate(version.publishedAt.slice(0, 10)) : ""}`.trim();

  return <ReportStudioFrame jobId={jobId} page="printing">
    <div className="nzs-toolbar" role="toolbar" aria-label="Report view">
      {kind === "draft" && draft
        ? <div className="nzs-ctl nzs-scope-live"><ReportScopeSelector choices={draft.scopeChoices} scope={scope} onChange={changeScope} disabled={pending !== null} /></div>
        : <div className="nzs-ctl">
          <span className="nzs-ctl-label">Scope</span>
          <div className="nzs-seg" aria-disabled="true" title="The scope is fixed when the version is validated">
            <span className={whole ? "on" : ""}>Whole client</span><span className={whole ? "" : "on"}>By site</span>
          </div>
          {whole ? null : <span className="nzs-hint">{version?.scopeLabel}</span>}
        </div>}
      <span className="nzs-spacer" />
      <span className={`nzs-status ${kind === "published" ? "issued" : kind}`} data-studio-status={kind}>{status}</span>
      {kind === "draft" ? <button type="button" className="nz-btn pri" data-studio-validate disabled={!draft || draft.blockers.length > 0 || pending !== null}
        title={draft && draft.blockers.length > 0 ? "Resolve what validation would refuse first" : undefined} onClick={validate}>{pending === "validate" ? "Validating…" : "Validate this report"}</button> : null}
      <div className="nzs-seg" role="group" aria-label="View">
        <button type="button" className={mode === "flow" ? "on" : ""} aria-pressed={mode === "flow"} onClick={() => setMode("flow")}>Continuous</button>
        <button type="button" className={mode === "page" ? "on" : ""} aria-pressed={mode === "page"} onClick={() => setMode("page")}>Page · A4</button>
      </div>
    </div>
    <div className="nzs-body">
      <nav className="nzs-rail" aria-label="Report sections">
        <div className="nzs-rail-head">Report sections</div>
        <ol className="nzs-rail-list">
          {rail.map((row) => {
            const at = movable.findIndex((item) => item.key === row.key);
            return <li key={row.key} className={`nzs-rail-row${row.drawn ? "" : " off"}`} data-rail-key={row.key}>
              <span className="nzs-grip">
                <button type="button" aria-label={`Move ${row.title} earlier`} disabled={!editable || !row.movable || at <= 0}
                  onClick={() => changePlan(moveReportSection(plan, row.key, "earlier"))}>▲</button>
                <button type="button" aria-label={`Move ${row.title} later`} disabled={!editable || !row.movable || at < 0 || at === movable.length - 1}
                  onClick={() => changePlan(moveReportSection(plan, row.key, "later"))}>▼</button>
              </span>
              <button type="button" className="nzs-rail-link" onClick={() => goTo(row.key, row.title)} disabled={!row.drawn || dirty} title={row.note ?? `Go to ${row.title}`}>
                <span className="nzs-rail-num">{row.number ?? ""}</span>
                <span className={`nzs-dot ${row.drawn ? "locked" : "none"}`} aria-hidden="true" />
                <span className="nzs-rail-title">{row.title}</span>
              </button>
              <button type="button" className={`nzs-switch${row.included ? " on" : ""}`} role="switch" aria-checked={row.included}
                disabled={!editable || !row.optional}
                aria-label={`${row.title}: ${row.included ? "shown" : "left out"}`}
                title={!row.optional ? "Always included in a report" : kind === "published" ? "A published report is fixed" : row.included ? "Shown — click to leave out" : "Left out — click to show"}
                onClick={() => changePlan(setReportSectionIncluded(plan, row.key, !row.included, { allowExclusion: true }))} />
            </li>;
          })}
        </ol>
        {dirty ? <div className="nzs-rail-save">
          <button type="button" className="nz-btn pri" data-studio-save disabled={pending !== null} onClick={savePlan}>{pending === "save" ? "Saving…" : "Save section plan"}</button>
          <button type="button" className="nz-btn" disabled={pending !== null} onClick={() => { setPlan(drawnPlan); setMessage(null); }}>Discard</button>
          <p className="nzs-rail-note">Unsaved. The document shows the saved plan until this is saved.</p>
        </div> : null}
        {message ? <p className="nzs-rail-msg" role="alert">{message}</p> : null}
        <ul className="nzs-legend" aria-label="Section status">
          {studioRailLegend.map((item) => <li key={item.status}><span className={`nzs-dot ${item.status}`} aria-hidden="true" />{item.label}</li>)}
        </ul>
        <p className="nzs-rail-note">{kind === "published" ? "This report is published: its sections are fixed." : kind === "validated"
          ? "Reorder or show and hide sections, then save. Publishing issues the saved plan."
          : "Reorder or show and hide sections, and choose the scope: the draft recomposes. Validating holds this plan."}</p>
      </nav>
      <div className={`nzs-stage mode-${mode}`} ref={stage} data-studio-view={mode}>
        {kind === "draft" && draft ? <div className="report-preview-band nzs-draft-band" role="note" data-report-draft="not-validated">
          <b>Draft — not validated, not issued.</b> Composed {formatDateTime(draft.draftedAt)} from this job&rsquo;s latest approved snapshot (version {draft.snapshotVersion}) with the plan and scope chosen here. Nothing here is stored or sent; validating holds it.
          {draft.blockers.length > 0 ? <ul className="nzs-blockers" data-studio-blockers>{draft.blockers.map((blocker, index) => <li key={`${blocker.field}-${index}`}>{blocker.message}</li>)}</ul> : null}
        </div> : kind === "validated" ? <div className="report-preview-band" role="note" data-report-preview="not-issued">
          <b>Preview — not issued.</b> Composed from this version&rsquo;s frozen snapshot and section plan, exactly as publishing would issue it. Nothing here is stored or sent.
        </div> : null}
        <ReportComposedView composition={composition} preview={kind !== "published"} />
      </div>
    </div>
  </ReportStudioFrame>;
}

/** Nothing to show: the job has no approved snapshot yet, so there is no report to prepare. */
export function ReportStudioEmpty({ jobId }: { jobId: string }) {
  return <ReportStudioFrame jobId={jobId} page="printing">
    <section className="nz-empty nzs-empty" data-studio-empty>
      <h1>Nothing to print yet</h1>
      <p>Report Printing composes the report from the job&rsquo;s approved reviewed snapshot. This job has none yet: its evidence is reviewed and approved first.</p>
      <Link className="nz-btn pri" href={`/report-preview?jobId=${encodeURIComponent(jobId)}`}>Open Report Preparation</Link>
    </section>
  </ReportStudioFrame>;
}
