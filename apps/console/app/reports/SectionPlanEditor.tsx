"use client";

// Reporting F-1b — the section order, as the client's report profile and the preparation page edit it. Reorder-only (the Q5
// interlock): leaving a section out arrives when the client portal shows the issued report itself, so this offers no
// include/exclude switch — and the server refuses one regardless. The cover and the methodology hold their places; the
// narrative sections are not drawn yet (Q6), so they are not listed.
import { isMovableReportSection, isReportDataSection, moveReportSection, reportPlanSectionTitle, type ReportSectionPlan } from "@nzi/contracts";

export function SectionPlanEditor({ plan, onChange, disabled = false, label = "Section order" }: {
  plan: ReportSectionPlan; onChange: (plan: ReportSectionPlan) => void; disabled?: boolean; label?: string;
}) {
  const shown = plan.filter((entry) => isReportDataSection(entry.key) && entry.included);
  const movable = shown.filter((entry) => isMovableReportSection(entry.key));
  return <div className="nz-section-plan" role="group" aria-label={label}>
    <ol className="nz-section-plan-list">
      {shown.map((entry) => {
        const at = movable.findIndex((item) => item.key === entry.key);
        const fixed = at < 0;
        const title = reportPlanSectionTitle(entry.key);
        return <li key={entry.key} className={fixed ? "fixed" : undefined}>
          <span className="nm">{title}</span>
          {fixed
            ? <span className="muted">{entry.key === "cover" ? "Always first" : "Always last"}</span>
            : <span className="mv">
              <button type="button" className="nz-editlink" disabled={disabled || at === 0} aria-label={`Move ${title} earlier`}
                onClick={() => onChange(moveReportSection(plan, entry.key, "earlier"))}>↑</button>
              <button type="button" className="nz-editlink" disabled={disabled || at === movable.length - 1} aria-label={`Move ${title} later`}
                onClick={() => onChange(moveReportSection(plan, entry.key, "later"))}>↓</button>
            </span>}
        </li>;
      })}
    </ol>
    <p className="sub">Every section stays in the report. Leaving one out arrives once the client portal shows the issued report itself, so a client never sees a section you meant to leave out.</p>
  </div>;
}
