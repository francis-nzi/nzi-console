"use client";

// R1 (NZC-050): the print/PDF step waits on exactly one deterministic signal —
// `[data-report-ready="true"]` on the report sheet, set server-side once every
// section and chart SVG is in the DOM and every figure reconciles to Outputs.
// No arbitrary sleeps. When the flag is off the attribute is absent and print
// proceeds immediately, as before.
function reportReady(): boolean {
  const sheet = document.querySelector(".report-sheet");
  const flag = sheet?.getAttribute("data-report-ready");
  return flag === null || flag === undefined || flag === "true";
}

export function PrintButton() {
  const print = () => {
    if (reportReady()) {
      window.print();
      return;
    }
    // data-report-ready="false" — a chart figure did not reconcile; block the
    // print rather than emit a report whose charts disagree with Outputs.
    const sheet = document.querySelector(".report-sheet");
    sheet?.querySelector(".nz-report-integrity")?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  return <button className="nz-btn pri report-print-action" onClick={print} aria-label="Print immutable report version or save it as a PDF"><span className="report-print-icon">↓</span><span><b>Print or save PDF</b><small>Current immutable version</small></span></button>;
}
