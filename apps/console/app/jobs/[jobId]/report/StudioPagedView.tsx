"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Paged.js does not repeat a table's header on the pages a table continues onto — the print engine does, from
 * `thead{display:table-header-group}` — so the preview would show one page fewer than the PDF on a long audit. This puts the
 * header back. After each page it notes the tables the page ended inside; when the next page draws its first row into such a
 * table, the table gets its `thead` again, before that page is measured, so the header counts towards the page like any row.
 */
export function repeatingTableHeaders(Handler: typeof import("pagedjs").Handler) {
  return class RepeatingTableHeaders extends Handler {
    private split = new Set<string>();
    afterPageLayout(_page: Element, _info: unknown, breakToken?: { node?: Node | null }) {
      this.split = new Set();
      let element: Element | null = breakToken?.node ? (breakToken.node.nodeType === 1 ? breakToken.node as Element : breakToken.node.parentElement) : null;
      for (; element; element = element.parentElement) if (element.tagName === "TABLE" && (element as HTMLElement).dataset.ref) this.split.add((element as HTMLElement).dataset.ref!);
    }
    renderNode(clone: Node, node: Node) {
      if (!this.split.size || clone.nodeType !== 1 || node.nodeType !== 1) return;
      const table = (clone as Element).closest("table[data-ref]") as HTMLElement | null;
      // Paged.js keeps handlers module-wide, so this acts only inside the studio's composed@5 document — never the issued
      // report's own Page view, which is left exactly as it was.
      if (!table || !table.closest(".nzr5") || !this.split.has(table.dataset.ref!) || table.querySelector(":scope > thead")) return;
      const header = (node as Element).closest("table")?.querySelector(":scope > thead");
      if (header) table.insertBefore(header.cloneNode(true), table.firstChild);
    }
  };
}
let headersRegistered = false;

/**
 * DESIGN-report-studio-small-fixes D/E: the studio's "Page · A4" for a composed@5 document — real pagination by Paged.js, from the
 * same rules the studio's print / Save as PDF uses (`studioPrint.ts`), so what this shows is what the PDF holds. A section taller
 * than a page flows onto the next, its table header repeating; a chart or row is never cut.
 *
 * It paginates a copy of the flow document the studio has drawn (`source`), never the renderer's markup changed: composed@5 and
 * every other renderer draw exactly as before. Paged.js loads on first use only. A failure says so, and Continuous view and
 * Print are unaffected.
 */
export function StudioPagedView({ source, css, readKey }: { source: RefObject<HTMLElement | null>; css: string; readKey: unknown }) {
  const target = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setError(null);
    (async () => {
      try {
        const document = source.current?.querySelector<HTMLElement>(".nzr5");
        const into = target.current;
        if (!document || !into) throw new Error("The report is not available to paginate.");
        // A copy, out of Continuous view's own mode: the paged rules then style it alone.
        const copy = document.cloneNode(true) as HTMLElement;
        copy.className = "nzr5 r5-mode-paged";
        const { Previewer, Handler, registerHandlers } = await import("pagedjs");
        if (cancelled) return;
        // Registered once per page load: Paged.js keeps its handlers module-wide.
        if (!headersRegistered) { registerHandlers(repeatingTableHeaders(Handler)); headersRegistered = true; }
        into.innerHTML = "";
        await new Previewer().preview(copy.outerHTML, [{ "studio-paged://inline.css": css }], into);
        if (!cancelled) setState("ready");
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Page view could not be built.");
        setState("failed");
      }
    })();
    return () => { cancelled = true; };
  }, [source, css, readKey]);

  return <div className="nzs-paged" data-studio-paged={state}>
    {state === "loading" ? <div className="nz-register-loading" role="status"><i /><span><b>Building the A4 page view</b><small>Paginating with the same rules as Print / Save as PDF…</small></span></div> : null}
    {state === "failed" ? <div className="nz-banner warn" role="alert"><div><b>Page view is unavailable</b><div>{error} Continuous view and Print / Save as PDF are unaffected.</div></div></div> : null}
    {/* In layout while it builds (Paged.js measures through offsetParent); hidden from assistive tech until it is ready. */}
    <div ref={target} className="nzs-paged-target" aria-hidden={state !== "ready"} hidden={state === "failed"} />
  </div>;
}
