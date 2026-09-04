"use client";

// R5b (NZC-051) — the on-screen Continuous / Page view · A4 toggle.
//
// Continuous (default): the report renders exactly as it always has, plus
// lightweight "Page N break" markers computed by measuring the rendered
// top-level blocks against the A4 content height — advisory editing guides,
// not a fidelity claim (Francis, 4 Sep 2026).
//
// Page view · A4: Paged.js, dynamically imported only on first switch to this
// mode (never part of the default report bundle), paginates a clone of the
// report content using the SAME paged-media rules the real print/PDF path
// uses (`reportPrintRules.ts`) — repeating audit-table headers, row-atomic
// breaks, appendix page-starts — plus a running header/footer with page
// numbers via CSS Generated Content for Paged Media, suppressed on the cover.
// The server/browser print engine stays the authoritative source of truth;
// this is a high-fidelity *preview* of it, not a byte-identity guarantee.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { buildReportPagedCss, type ReportPagedMeta } from "./reportPrintRules";
import { computePageBreakIndices } from "./reportPageBreaks";

type Mode = "flow" | "page";
type PageState = "idle" | "loading" | "ready" | "failed";

export function ReportPagedView({ meta, children }: { meta: ReportPagedMeta; children: ReactNode }) {
  const [mode, setMode] = useState<Mode>("flow");
  const flowRef = useRef<HTMLDivElement | null>(null);
  const pagedTargetRef = useRef<HTMLDivElement | null>(null);
  const [pageState, setPageState] = useState<PageState>("idle");
  const [pageError, setPageError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "flow") return;
    const sheet = flowRef.current?.querySelector<HTMLElement>(".report-sheet");
    if (!sheet) return;
    for (const marker of Array.from(sheet.querySelectorAll(":scope > .pbreak"))) marker.remove();
    const blocks = Array.from(sheet.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && !el.classList.contains("pbreak"),
    );
    const heights = blocks.map((block) => block.getBoundingClientRect().height);
    const breakBefore = new Set(computePageBreakIndices(heights));
    const inserted: HTMLElement[] = [];
    let page = 1;
    blocks.forEach((block, index) => {
      if (!breakBefore.has(index)) return;
      page += 1;
      const marker = document.createElement("div");
      marker.className = "pbreak";
      marker.setAttribute("role", "note");
      marker.innerHTML = `<span class="pb-num">Page ${page} break</span>`;
      block.before(marker);
      inserted.push(marker);
    });
    return () => { for (const marker of inserted) marker.remove(); };
  }, [mode]);

  useEffect(() => {
    if (mode !== "page") return;
    let cancelled = false;
    setPageState("loading");
    setPageError(null);
    (async () => {
      try {
        const sheet = flowRef.current?.querySelector<HTMLElement>(".report-sheet");
        const target = pagedTargetRef.current;
        if (!sheet || !target) throw new Error("Report content is not available to paginate.");
        const clone = sheet.cloneNode(true) as HTMLElement;
        for (const marker of Array.from(clone.querySelectorAll(".pbreak"))) marker.remove();
        const { Previewer } = await import("pagedjs");
        if (cancelled) return;
        target.innerHTML = "";
        const previewer = new Previewer();
        await previewer.preview(clone.innerHTML, [{ "report-paged://inline.css": buildReportPagedCss(meta) }], target);
        if (cancelled) return;
        setPageState("ready");
      } catch (error) {
        if (cancelled) return;
        setPageError(error instanceof Error ? error.message : "Page view could not be built.");
        setPageState("failed");
      }
    })();
    return () => { cancelled = true; };
  }, [mode, meta]);

  return <>
    <div className="report-view-toggle" role="tablist" aria-label="Report view">
      <button type="button" role="tab" aria-selected={mode === "flow"} className={mode === "flow" ? "on" : ""} onClick={() => setMode("flow")}>Continuous</button>
      <button type="button" role="tab" aria-selected={mode === "page"} className={mode === "page" ? "on" : ""} onClick={() => setMode("page")}>Page view · A4</button>
    </div>
    <div ref={flowRef} hidden={mode !== "flow"}>{children}</div>
    {mode === "page" && <div className="report-pagedjs-wrap">
      {pageState === "loading" && <div className="nz-register-loading" role="status"><i /><span><b>Building the A4 page view</b><small>Applying the same paged-media rules as the printed PDF…</small></span></div>}
      {pageState === "failed" && <div className="nz-banner warn" role="alert"><div><b>Page view is unavailable</b><div>{pageError} The Continuous view and Print/Save as PDF are unaffected.</div></div></div>}
      <div ref={pagedTargetRef} className="report-pagedjs-target" hidden={pageState !== "ready"} />
    </div>}
  </>;
}
