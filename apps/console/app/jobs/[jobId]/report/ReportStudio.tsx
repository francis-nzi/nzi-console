"use client";

import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";
import type { ReportComposition } from "@nzi/contracts";
import { jobCrumbs, workspaceCrumbs } from "../../../lib/crumbs";
import { formatDate } from "../../../lib/formatDate";
import { useJobReportRow } from "../../../lib/useJobReportRow";
import { PrepareFrame } from "../../../report-preview/PrepareFrame";
import { ReportComposedView } from "../../../reports/[versionId]/ReportComposedView";
import { studioRail, studioRailLegend, type StudioVersion } from "./studio";

/**
 * B2-1 (RULING-report-studio-B2): the Report Studio, to `REPORT-STUDIO-design-reference.html` — the job's report in the console's
 * chrome, with its three sub-pages, the section rail beside the composed document, and the view control.
 *
 * Display only. The document is the composed renderer drawing the version's frozen composition (published) or its B0 preview
 * (validated) — unchanged, so every pinned renderer draws exactly as before; the studio is chrome around it. The rail reads the
 * version's own plan; reordering and include toggles arrive with B2-2, in-place editing with B2-4, Word / Issue PDF with B2-5.
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

/** Report Printing: the toolbar, the section rail and the composed document. */
export function ReportStudioPrinting({ jobId, version, composition }: { jobId: string; version: StudioVersion; composition: ReportComposition }) {
  const [mode, setMode] = useState<ViewMode>("flow");
  const stage = useRef<HTMLDivElement | null>(null);
  const rail = studioRail(composition);
  const preview = version.status === "validated";
  const whole = (composition.scope?.kind ?? "whole") === "whole";
  // The rail names a page by the heading the document gives it; the document itself is not touched (its markup is pinned).
  const goTo = (key: string, title: string) => {
    const root = stage.current;
    if (!root) return;
    const target = key === "cover"
      ? root.querySelector<HTMLElement>(".nzr-cover")
      : Array.from(root.querySelectorAll<HTMLElement>("section.nzr-page")).find((page) => page.querySelector("h2")?.textContent?.trim() === title) ?? null;
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return <ReportStudioFrame jobId={jobId} page="printing">
    <div className="nzs-toolbar" role="toolbar" aria-label="Report view">
      <div className="nzs-ctl">
        <span className="nzs-ctl-label">Scope</span>
        <div className="nzs-seg" aria-disabled="true" title="The scope is chosen when the version is validated">
          <span className={whole ? "on" : ""}>Whole client</span><span className={whole ? "" : "on"}>By site</span>
        </div>
        {whole ? null : <span className="nzs-hint">{version.scopeLabel}</span>}
      </div>
      <span className="nzs-spacer" />
      <span className={`nzs-status ${preview ? "preview" : "issued"}`} data-studio-status={version.status}>
        {preview ? "Validated — preview, not issued" : `Published ${version.publishedAt ? formatDate(version.publishedAt.slice(0, 10)) : ""}`.trim()}
      </span>
      <div className="nzs-seg" role="group" aria-label="View">
        <button type="button" className={mode === "flow" ? "on" : ""} aria-pressed={mode === "flow"} onClick={() => setMode("flow")}>Continuous</button>
        <button type="button" className={mode === "page" ? "on" : ""} aria-pressed={mode === "page"} onClick={() => setMode("page")}>Page · A4</button>
      </div>
    </div>
    <div className="nzs-body">
      <nav className="nzs-rail" aria-label="Report sections">
        <div className="nzs-rail-head">Report sections</div>
        <ol className="nzs-rail-list">
          {rail.map((row) => <li key={row.key} className={`nzs-rail-row${row.drawn ? "" : " off"}`} data-rail-key={row.key}>
            <button type="button" className="nzs-rail-link" onClick={() => goTo(row.key, row.title)} disabled={!row.drawn} title={row.note ?? `Go to ${row.title}`}>
              <span className="nzs-rail-num">{row.number ?? ""}</span>
              <span className={`nzs-dot ${row.drawn ? "locked" : "none"}`} aria-hidden="true" />
              <span className="nzs-rail-title">{row.title}</span>
            </button>
            <span className={`nzs-switch${row.included ? " on" : ""}`} role="switch" aria-checked={row.included} aria-disabled="true"
              aria-label={`${row.title}: ${row.included ? "shown" : "left out"}`} title={row.note ?? "Shown in this report"} />
          </li>)}
        </ol>
        <ul className="nzs-legend" aria-label="Section status">
          {studioRailLegend.map((item) => <li key={item.status}><span className={`nzs-dot ${item.status}`} aria-hidden="true" />{item.label}</li>)}
        </ul>
        <p className="nzs-rail-note">The plan was fixed when this version was validated. Reordering and showing or hiding sections here arrive next.</p>
      </nav>
      <div className={`nzs-stage mode-${mode}`} ref={stage} data-studio-view={mode}>
        {preview ? <div className="report-preview-band" role="note" data-report-preview="not-issued">
          <b>Preview — not issued.</b> Composed from this version&rsquo;s frozen snapshot and section plan, exactly as publishing would issue it. Nothing here is stored or sent.
        </div> : null}
        <ReportComposedView composition={composition} preview={preview} />
      </div>
    </div>
  </ReportStudioFrame>;
}

/** No version to show yet: the report is prepared (and validated) first. */
export function ReportStudioEmpty({ jobId }: { jobId: string }) {
  return <ReportStudioFrame jobId={jobId} page="printing">
    <section className="nz-empty nzs-empty" data-studio-empty>
      <h1>Nothing to print yet</h1>
      <p>Report Printing shows a validated or published report version. This job has neither yet: prepare and validate its report first.</p>
      <Link className="nz-btn pri" href={`/report-preview?jobId=${encodeURIComponent(jobId)}`}>Open Report Preparation</Link>
    </section>
  </ReportStudioFrame>;
}
