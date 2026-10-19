"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import { crpProfessionalManifest } from "@nzi/charts";
import {
  drawsMockupDocument, moveReportSection, reportSectionPlanOf, setReportSectionIncluded, v7RecordLine,
  type ReportComposition, type ReportScope, type ReportSectionPlan,
} from "@nzi/contracts";
import type { ReportDraftComposition } from "@nzi/isolated-backend";
import { jobCrumbs, workspaceCrumbs } from "../../../lib/crumbs";
import { formatDate, formatDateTime } from "../../../lib/formatDate";
import { accessFor, useStaffMe, type EditAccess } from "../../../lib/useEditAccess";
import { useJobReportRow } from "../../../lib/useJobReportRow";
import { useReportSignees } from "../../../lib/useReportSignees";
import { PrepareFrame } from "../../../report-preview/PrepareFrame";
import { ReportScopeSelector } from "../../../report-preview/ReportScopeSelector";
import { ReportComposedView } from "../../../reports/[versionId]/ReportComposedView";
import type { NarrativeEditor } from "../../../reports/[versionId]/ReportComposedV5";
import { reportFeatureEnabled } from "../../../lib/reportFlags";
import { StudioNarrativeEditor, type NarrativeEditTarget } from "./StudioNarrativeEditor";
import { reportingYearLabel } from "../../../reports/[versionId]/ReportComposedV5";
import { StudioPagedView } from "./StudioPagedView";
import { buildStudioPagedCss, buildStudioPrintCss, studioPrintMark } from "./studioPrint";
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
  // The one path (CORRECTION-report-studio-live-path): drafting, sections, scope, validation and publishing are all on Report
  // Printing, so Preparation no longer opens the old /report-preview page — it arrives as its own sub-page with B2-6. Client
  // Review is still the review inbox on /reports until then.
  const tabs: Array<{ page: StudioPage; href: string | null }> = [
    { page: "preparation", href: null },
    { page: "printing", href: studioHref(jobId, "printing") },
    { page: "review", href: "/reports" },
  ];
  return <PrepareFrame crumbs={crumbs}>
    <div className="nzs-studio">
      <nav className="nzs-subnav" aria-label="Report">
        {tabs.map((tab) => tab.page === page
          ? <span key={tab.page} className="nzs-subnav-item on" aria-current="page">{PAGE_LABEL[tab.page]}</span>
          : tab.href === null
            ? <span key={tab.page} className="nzs-subnav-item soon" aria-disabled="true" title="Coming with B2-6. Drafting, sections, scope and validation are on Report Printing.">{PAGE_LABEL[tab.page]}</span>
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
  const flowSource = useRef<HTMLDivElement | null>(null);
  const kind: "draft" | "validated" | "published" = draft || !version ? "draft" : version.status;
  // D/E: composed@5 is paged for real — Page · A4 is Paged.js over the flow document, with the rules Print uses. Older
  // renderers (a version validated before composed@5) keep the view they have always had.
  const paged = drawsMockupDocument(composition);
  const printMeta = { client: composition.client, title: `Carbon Reduction Plan ${reportingYearLabel(composition)}`, mark: studioPrintMark(kind) };
  // A draft or a validated preview prints here, marked as what it is; the issued report keeps its own immutable print.
  const printable = kind !== "published";
  // The plan the document draws, and the plan the rail is editing (they differ only while a validated version's change is unsaved).
  const drawnPlan = reportSectionPlanOf(composition);
  const [plan, setPlan] = useState<ReportSectionPlan>(drawnPlan);
  const [scope, setScope] = useState<ReportScope>(draft?.scope ?? composition.scope ?? { kind: "whole" });
  const [pending, setPending] = useState<"save" | "validate" | "publish" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const editable = kind !== "published" && pending === null;
  const rail = studioRail(composition, plan);
  const dirty = kind === "validated" && !samePlan(plan, drawnPlan);
  const whole = scope.kind === "whole";

  // The signee validate freezes onto the version — the client's report-signee contacts, offered as the job page's release
  // panel offers them (the first by default; "No signee" is a choice, never a guess).
  const signees = useReportSignees(jobId, kind === "draft");
  const [signeeId, setSigneeId] = useState("");
  useEffect(() => { if (signees?.length) setSigneeId((current) => current && signees.some((item) => item.id === current) ? current : signees[0]!.id); }, [signees]);

  // Publishing (report.publish) on a validated version: shown with its access reason up front; the server stays authoritative
  // (it refuses the snapshot's preparer — NZC-022 — and a version that moved since this screen opened).
  const me = useStaffMe(kind !== "published");
  const publishAccess: EditAccess = me === undefined ? { state: "checking", reason: "Checking your permissions…" }
    : me === "signed-out" ? { state: "denied", reason: "Sign in as staff to publish." }
    : me === null ? { state: "unavailable", reason: "Your permissions could not be checked, so publishing is unavailable." }
    : accessFor(me, "report.publish");
  const [confirming, setConfirming] = useState(false);

  // B2-4 (C): the narrative is edited where it is drawn, behind `report-edit`, for someone holding `report.edit` (preparer work;
  // validate and publish stay the reviewer's, and publish still refuses the snapshot's preparer). On a draft each edit goes
  // through `report.section.*` and the draft recomposes; on a validated version (d)(ii) through `report.narrative.update`,
  // pinned by this version and bumping it, so it changes in place. A published version is never editable.
  const narrativeOn = reportFeatureEnabled("report-edit") && Boolean(composition.narrative);
  const narrativeTarget: NarrativeEditTarget | null = kind === "draft" ? { kind: "draft", jobId }
    : kind === "validated" && version ? { kind: "validated", reportVersionId: version.reportVersionId, version: version.version }
    : null;
  const editAccess: EditAccess = me === undefined ? { state: "checking", reason: "Checking your permissions…" }
    : me === "signed-out" ? { state: "denied", reason: "Sign in as staff to edit the narrative." }
    : me === null ? { state: "unavailable", reason: "Your permissions could not be checked, so editing is unavailable." }
    : accessFor(me, "report.edit");
  const narrativeEditor: NarrativeEditor | undefined = narrativeTarget && narrativeOn
    ? (_key, element, drawn) => <StudioNarrativeEditor target={narrativeTarget} composition={composition} element={element} drawn={drawn}
        canEdit={editAccess.state === "allowed" && pending === null} {...(editAccess.state === "allowed" ? {} : { blockedReason: editAccess.reason })} />
    : undefined;

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
      signeeContactId: signeeId || null,
    }, crypto.randomUUID());
    setPending(null);
    if (result.state === "success") { window.location.assign(`${studioHref(jobId)}?version=${encodeURIComponent(result.data.reportVersionId)}`); return; }
    setMessage(result.state === "validation_failed" ? result.issues?.map((issue) => issue.message).join(" ") || result.message || "Validation blocked." : result.message || "Validation failed.");
  }

  async function publish() {
    if (kind !== "validated" || !version || dirty || pending || publishAccess.state !== "allowed") return;
    setPending("publish");
    // report.publish pins exactly the version this screen opened — its row version, manifest and snapshot — so a version that
    // moved elsewhere (a saved plan change bumps it) is refused, never published unseen.
    const result = await postBrowserCommand<{ reportVersionId: string; publishedAt: string }>("/api/isolated/reports/publish", {
      reportVersionId: version.reportVersionId, expectedStatus: "validated", expectedVersion: version.version,
      manifestVersion: version.manifestVersion, reviewedSnapshotId: version.snapshotId,
    }, crypto.randomUUID());
    setPending(null);
    setConfirming(false);
    if (result.state === "success") { window.location.assign(`${studioHref(jobId)}?version=${encodeURIComponent(version.reportVersionId)}`); return; }
    setMessage(result.state === "validation_failed" ? result.issues?.map((issue) => issue.message).join(" ") || result.message || "Publication blocked." : result.message || "Publication failed.");
  }

  // The rail finds a page in the document without touching it (its markup is pinned): composed@5 marks each section with
  // `data-section`; composed@1–4 are found by the heading they give the page, as before.
  const goTo = (key: string, title: string) => {
    const root = stage.current;
    if (!root) return;
    // The copy on screen: in Page · A4 the flow document is the hidden source, so a section is found in the paged copy.
    const visible = <T extends HTMLElement>(nodes: NodeListOf<T> | T[]) => Array.from(nodes).find((node) => node.offsetParent !== null) ?? null;
    const target = key === "cover"
      ? visible(root.querySelectorAll<HTMLElement>(".nzr-cover, .r5-cover"))
      : visible(root.querySelectorAll<HTMLElement>(`[data-section="${CSS.escape(key)}"]`))
        ?? Array.from(root.querySelectorAll<HTMLElement>("section.nzr-page")).find((page) => page.querySelector("h2")?.textContent?.trim() === title) ?? null;
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
          <span className="nzs-ctl-label">Sites</span>
          <div className="nzs-seg" aria-disabled="true" title="The sites are fixed when the version is validated">
            <span className={whole ? "on" : ""}>Whole client</span><span className={whole ? "" : "on"}>By site</span>
          </div>
          <span className="nzs-hint">{whole ? "Whole client · all sites" : version?.scopeLabel}</span>
        </div>}
      <span className="nzs-spacer" />
      <span className={`nzs-status ${kind === "published" ? "issued" : kind}`} data-studio-status={kind}>{status}</span>
      {kind === "draft" ? <div className="nzs-ctl nzs-signee">
        <span className="nzs-ctl-label" aria-hidden="true">Signee</span>
        <select className="nz-sel" value={signeeId} onChange={(event) => setSigneeId(event.target.value)} disabled={pending !== null || !signees} aria-label="Report signee" data-studio-signee
          title="Frozen onto the validated version and shown on the report's sign-off. Only the client's contacts marked Report signee are offered.">
          {signees?.length ? null : <option value="">{signees === undefined ? "Loading signees…" : signees === null ? "Signees could not be read" : "No report-signee contacts"}</option>}
          {signees?.map((contact) => <option key={contact.id} value={contact.id}>{contact.fullName}{contact.jobTitle ? ` — ${contact.jobTitle}` : ""}</option>)}
          {signees?.length ? <option value="">No signee on this report</option> : null}
        </select>
      </div> : null}
      {kind === "draft" ? <button type="button" className="nz-btn pri" data-studio-validate disabled={!draft || draft.blockers.length > 0 || pending !== null}
        title={draft && draft.blockers.length > 0 ? "Resolve what validation would refuse first" : undefined} onClick={validate}>{pending === "validate" ? "Validating…" : "Validate this report"}</button> : null}
      {kind === "validated" && !confirming ? <button type="button" className="nz-btn pri" data-studio-publish
        disabled={dirty || pending !== null || publishAccess.state !== "allowed"}
        title={dirty ? "Save the section plan first, so the report issues as shown" : publishAccess.state !== "allowed" ? publishAccess.reason : "Publish this exact version to the client portal"}
        onClick={() => { setMessage(null); setConfirming(true); }}>Publish to client portal</button> : null}
      {kind === "validated" && confirming ? <span className="nzs-confirm" role="group" aria-label="Confirm publication" data-studio-publish-confirm>
        <span>Publish version {version?.reportVersionId} to the client portal? It cannot be changed afterwards.</span>
        <button type="button" className="nz-btn pri" disabled={pending !== null || dirty} onClick={publish}>{pending === "publish" ? "Publishing…" : "Publish"}</button>
        <button type="button" className="nz-btn" disabled={pending !== null} onClick={() => setConfirming(false)}>Cancel</button>
      </span> : null}
      {printable ? <button type="button" className="nz-btn" data-studio-print onClick={() => window.print()}
        title={`Prints exactly this document${printMeta.mark ? `, marked "${printMeta.mark}" on every page` : ""}. Choose "Save as PDF" in the print dialog.`}>Print / Save as PDF</button> : null}
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
          <b>Preview — not issued.</b> Composed from this version&rsquo;s frozen snapshot and section plan, exactly as publishing would issue it.{narrativeEditor ? null : " Nothing here is stored or sent."}
          {composition.narrative ? narrativeEditor
            ? <> The narrative was frozen with this version when it was validated, and <b>is editable here, on this validated version</b>: each save changes it in place and bumps the version — nothing is re-validated. Publishing issues exactly the narrative frozen on it.</>
            : <> The narrative was frozen with this version when it was validated; publishing issues exactly that.</> : null}
        </div> : null}
        {paged ? <>
          <div className="nzs-paged-source" ref={flowSource} hidden={mode === "page"}>
            <ReportComposedView composition={composition} preview={kind !== "published"} mode="flow" narrativeEditor={narrativeEditor} />
          </div>
          {mode === "page" ? <StudioPagedView source={flowSource} css={buildStudioPagedCss(printMeta)} readKey={composition} /> : null}
        </> : <ReportComposedView composition={composition} preview={kind !== "published"} mode={mode} />}
        {printable ? <style data-studio-print-css>{buildStudioPrintCss(printMeta)}</style> : null}
      </div>
    </div>
  </ReportStudioFrame>;
}

/**
 * Nothing to draft: the job has no approved reviewed snapshot. Said for what it is — as the old preparation page said it, so
 * the studio no longer sends anyone back there (the one path): imported v7 history awaiting re-compose; a snapshot awaiting
 * approval by someone other than its preparer; a job with no evidence yet; or, unread, that it could not be told which.
 */
export function ReportStudioEmpty({ jobId }: { jobId: string }) {
  const row = useJobReportRow(jobId);
  const job = `/jobs/${encodeURIComponent(jobId)}`;
  const state = row === undefined ? "checking" : row === null ? "unread" : row.v7Record && !row.hasSnapshot ? "v7" : row.hasSnapshot ? "awaiting-approval" : "no-evidence";
  return <ReportStudioFrame jobId={jobId} page="printing">
    <section className="nz-empty nzs-empty" data-studio-empty={state}>
      <h1>Nothing to print yet</h1>
      {state === "checking" ? <p>Reading the job&rsquo;s report state…</p>
        : state === "v7" ? <><p>This period&rsquo;s record of account is its NZ Insights Pro v7 report — there is no console snapshot to compose yet. It is slated for re-compose: once its v7 figures are re-ingested and reviewed, its report is drafted here.</p>
          <p className="nz-v7-record-line">{v7RecordLine(row!.v7Report)} Its content is kept sealed as issued.</p></>
        : state === "awaiting-approval" ? <p>This job&rsquo;s reviewed snapshot is awaiting approval by someone other than its preparer. Once it is approved on the job, its report is drafted here.</p>
        : state === "no-evidence" ? <p>Report Printing composes the report from the job&rsquo;s approved reviewed snapshot. This job has none yet: add and review its evidence, then take and approve a snapshot of it.</p>
        : <p>No approved snapshot was found for this job, and whether it is imported history or a job awaiting evidence could not be checked. Nothing has been assumed.</p>}
      <Link className="nz-btn pri" href={job}>Open the job</Link>
    </section>
  </ReportStudioFrame>;
}
