"use client";

import { useState } from "react";
import { postBrowserCommand } from "@nzi/api-client";

/**
 * Print or save the readiness report as a PDF — the browser's own print engine, as the issued CRP report uses. The export
 * is put on the record first (`srs.report.export`: which completed assessment, which template); if that is refused the
 * report is not printed, so every PDF that leaves has a line in the audit trail.
 */
export function SrsReportPrint({ assessmentId, templateKey }: { assessmentId: string; templateKey: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function print() {
    setPending(true); setError(null);
    const result = await postBrowserCommand(`/api/isolated/srs-assessments/${encodeURIComponent(assessmentId)}/report-export`, { templateKey }, crypto.randomUUID());
    setPending(false);
    if (result.state !== "success") { setError(result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.message); return; }
    window.print();
  }
  return <div className="nzsr-actions">
    <button type="button" className="nz-btn pri" disabled={pending} onClick={() => void print()}>{pending ? "Preparing…" : "Print or save PDF"}</button>
    {error ? <span className="nz-banner warn" role="alert">{error}</span> : null}
  </div>;
}
