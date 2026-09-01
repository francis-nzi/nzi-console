"use client";
// UX1d — the client-portal scope→category data-entry accordion (NZC-046 /
// DATA_ENTRY_UX.md §1, §5). A constrained mirror of the CRP accordion: only the
// categories the client's bucket grants authorise, each collapsed, with the
// existing submit-to-review surfaces re-homed into their section. Behind the
// `data-entry-accordion` flag.
import { useState } from "react";
import { buildPortalDataEntryAccordion, type PortalBucket } from "./portalEntryGrouping";
import { PortalEntryRecords } from "./PortalEntryRecords";
import { PortalSpendEntry } from "./PortalSpendEntry";
import { dataEntryAdapterEnabled } from "../lib/featureFlags";

const scopeColour = (scope: string) => (scope === "1" ? "var(--s1)" : scope === "2" ? "var(--s2)" : "var(--s3)");
const KIND_NOTE: Record<string, string> = {
  spend: "Enter the net value, VAT and GL code, and choose your authorised category. NZI maps the factor.",
  vehicle: "Registration finder (DVLA) or manual — make, model, fuel.",
  travel: "Registration finder, air, rail and other travel types — or enter manually.",
  commuting: "Registration finder, mode, or working-from-home days.",
  fugitive: "Refrigerant top-ups. Enter a quantity and unit.",
  manual: "Enter a quantity and unit, with an optional monthly breakdown.",
};

export function PortalDataEntryAccordion({
  jobId,
  buckets,
  reportingMonths,
}: {
  jobId: string;
  buckets: PortalBucket[];
  reportingMonths: string[];
}) {
  const sections = buildPortalDataEntryAccordion(buckets);
  const [open, setOpen] = useState<Set<string>>(() => new Set(sections.length === 1 ? [sections[0]!.code] : []));
  const spendOn = dataEntryAdapterEnabled("portal-spend");
  const toggle = (code: string) =>
    setOpen(current => {
      const next = new Set(current);
      next.has(code) ? next.delete(code) : next.add(code);
      return next;
    });

  if (!sections.length) {
    return <div className="nz-acc-empty" style={{ marginTop: 16 }}>No entry categories are authorised yet.</div>;
  }

  return (
    <div className="nz-acc" aria-label="Authorised data-entry categories" style={{ marginTop: 16 }}>
      {(["1", "2", "3"] as const).map(scope => {
        const inScope = sections.filter(section => section.scope === scope);
        if (!inScope.length) return null;
        return (
          <div key={scope}>
            <div className="nz-acc-scopehead"><span className="sdot" style={{ background: scopeColour(scope) }} />Scope {scope}</div>
            {inScope.map(section => {
              const isOpen = open.has(section.code);
              const otherBuckets = spendOn ? section.otherBuckets : section.buckets;
              return (
                <div key={section.code} className={`nz-acc-cat${isOpen ? " open" : ""}`} style={{ "--cc": scopeColour(scope) } as React.CSSProperties}>
                  <button type="button" className="nz-acc-h" aria-expanded={isOpen} onClick={() => toggle(section.code)}>
                    <span className="nz-acc-badge">{section.name.slice(0, 1)}</span>
                    <span className="nz-acc-tt">
                      <b>{section.name}</b>
                      <span className="sum">{section.buckets.length} authorised {section.buckets.length === 1 ? "bucket" : "buckets"}</span>
                    </span>
                    <svg className="nz-acc-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 9l6 6 6-6" /></svg>
                  </button>
                  {isOpen ? (
                    <div className="nz-acc-body">
                      <div className="nz-acc-kindnote">⌁ {KIND_NOTE[section.kind] ?? KIND_NOTE.manual}</div>
                      {spendOn && section.spendBuckets.length ? (
                        <PortalSpendEntry jobId={jobId} buckets={section.spendBuckets} reportingMonths={reportingMonths} />
                      ) : null}
                      {otherBuckets.length ? <PortalEntryRecords jobId={jobId} buckets={otherBuckets} /> : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
