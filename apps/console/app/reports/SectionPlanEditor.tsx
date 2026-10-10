"use client";

// Reporting F-1b / F-4b — the section plan, as the client's report profile and the preparation page edit it: the order of the
// data sections, and (F-4b, now the portal shows the issued report itself) which optional sections are left out. The cover and
// the methodology hold their places; the cover, executive summary, emissions and methodology are always included (Q1); the
// narrative sections are not drawn yet (Q6), so they are not listed. A left-out section stays in the list, marked, so it can be
// put back — and the issued report says on its Methodology page that it was left out.
import { isMovableReportSection, isOptionalReportSection, isReportDataSection, moveReportSection, REPORT_SECTION_EXCLUSION_AVAILABLE, reportPlanSectionTitle, setReportSectionIncluded, type ReportSectionPlan } from "@nzi/contracts";

// While exclusion is held (RULING-reporting-F4b-flip-and-dashboard) the editor is reorder-only, as in F-1b; `allowExclusion`
// follows the one switch, and exists so the include switch can be tested before it is turned on.
export function SectionPlanEditor({ plan, onChange, disabled = false, label = "Section order", allowExclusion = REPORT_SECTION_EXCLUSION_AVAILABLE }: {
  plan: ReportSectionPlan; onChange: (plan: ReportSectionPlan) => void; disabled?: boolean; label?: string; allowExclusion?: boolean;
}) {
  const shown = plan.filter((entry) => isReportDataSection(entry.key) && (entry.included || allowExclusion));
  const movable = shown.filter((entry) => isMovableReportSection(entry.key));
  return <div className="nz-section-plan" role="group" aria-label={label}>
    <ol className="nz-section-plan-list">
      {shown.map((entry) => {
        const at = movable.findIndex((item) => item.key === entry.key);
        const fixed = at < 0;
        const title = reportPlanSectionTitle(entry.key);
        const optional = allowExclusion && isOptionalReportSection(entry.key);
        return <li key={entry.key} className={[fixed ? "fixed" : "", entry.included ? "" : "left-out"].filter(Boolean).join(" ") || undefined}>
          <span className="nm">{title}{entry.included ? null : <span className="muted"> · left out</span>}</span>
          {optional
            ? <label className="nz-section-plan-include"><input type="checkbox" checked={entry.included} disabled={disabled}
                onChange={(event) => onChange(setReportSectionIncluded(plan, entry.key, event.target.checked, { allowExclusion }))} /> Include</label>
            : null}
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
    <p className="sub">{allowExclusion
      ? "Untick a section to leave it out. It is then absent from the issued report and from the client's portal, and the report's Methodology page says it was left out. The cover, executive summary, emissions and methodology are always included."
      : "Every section stays in the report. Leaving one out arrives once every view the client has of the report honours it, so a client never sees a section you meant to leave out."}</p>
  </div>;
}
