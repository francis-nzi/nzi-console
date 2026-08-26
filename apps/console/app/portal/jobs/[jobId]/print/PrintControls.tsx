"use client";

export function PrintControls() {
  return <div className="print-controls">
    <div className="print-controls-inner">
      <a href="../" className="print-back"><span>←</span><span><b>Published report</b><small>Return to client workspace</small></span></a>
      <div className="print-status"><i>✓</i><span><b>Print-ready version</b><small>Charts and evidence are fixed to this publication</small></span></div>
      <button className="nz-btn pri" onClick={() => window.print()}>Print or save as PDF</button>
    </div>
  </div>;
}
