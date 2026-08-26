"use client";

export function PrintButton() {
  return <button className="nz-btn pri report-print-action" onClick={() => window.print()} aria-label="Print immutable report version or save it as a PDF"><span className="report-print-icon">↓</span><span><b>Print or save PDF</b><small>Current immutable version</small></span></button>;
}
