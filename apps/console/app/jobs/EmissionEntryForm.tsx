"use client";
// UX1a — the one shared capture component (NZC-046 / DATA_ENTRY_UX.md §3).
// Renders `buildEmissionEntryFields` verbatim so the CRP workspace and the client
// portal are the same process: identical field order, progressive disclosure keyed
// on the category kind, the portal a constrained mirror that never shows the
// factor / quality / confidence / lineage fields. Endpoint wiring is the caller's
// job (UX1b CRP accordion, UX1d portal accordion) — this component is presentational.
import { type FormEvent, useId, useMemo, useState } from "react";
import type { EmissionCategory } from "@nzi/contracts";
import {
  buildEmissionEntryFields,
  emissionEntryActions,
  isRegistrationKind,
  isSpendKind,
  manualEntryHint,
  type EmissionEntryDraft,
  type EmissionEntryLineageStep,
  type EntryAudience,
  type EntryFactorOption,
  type EntryMode,
} from "./emissionEntryModel";

export * from "./emissionEntryModel";

export type EmissionEntryFormProps = {
  category: EmissionCategory;
  audience: EntryAudience;
  /** Site is context (§2) — chosen at the top of data entry, shown here read-only. */
  site: { id: string | null; label: string };
  /** Scope + category-scoped factor set, already filtered by the caller. */
  factors: EntryFactorOption[];
  units: string[];
  reportingMonths: string[];
  spendCategories?: { id: string; name: string }[];
  entry?: (Partial<EmissionEntryDraft> & { title?: string }) | null;
  lineage?: EmissionEntryLineageStep[];
  provenance?: { label: string; value: string }[];
  busy?: boolean;
  error?: string;
  notice?: string;
  onSubmit: (draft: EmissionEntryDraft) => void | Promise<void>;
  onSaveDraft?: (draft: EmissionEntryDraft) => void | Promise<void>;
  onCancel: () => void;
  onReject?: () => void | Promise<void>;
  onApprove?: () => void | Promise<void>;
  onLookupRegistration?: (registration: string) => void | Promise<void>;
};

const QUALITY_TIERS = ["Measured", "Estimated", "Spend-based", "Survey"] as const;
const DATA_CONFIDENCE = ["H — High", "M — Medium", "L — Low"] as const;
const CLIENT_FACTOR_OPTION = "__client_factor__";

const monthLabel = (key: string) => {
  const parsed = new Date(`${key}-01T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? key
    : parsed.toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });
};

const blankDraft = (units: string[], seed?: Partial<EmissionEntryDraft> | null): EmissionEntryDraft => ({
  activity: seed?.activity ?? "",
  quantity: seed?.quantity ?? "",
  unit: seed?.unit ?? units[0] ?? "",
  vatPercent: seed?.vatPercent ?? "",
  glCode: seed?.glCode ?? "",
  spendCategoryId: seed?.spendCategoryId ?? "",
  registration: seed?.registration ?? "",
  manualMode: seed?.manualMode ?? false,
  manualDetail: seed?.manualDetail ?? "",
  factorId: seed?.factorId ?? "",
  qualityTier: seed?.qualityTier ?? QUALITY_TIERS[0],
  dataConfidence: seed?.dataConfidence ?? DATA_CONFIDENCE[1],
  note: seed?.note ?? "",
  monthlyOpen: seed?.monthlyOpen ?? false,
  monthly: seed?.monthly ?? {},
});

export function EmissionEntryForm(props: EmissionEntryFormProps) {
  const { category, audience, site, factors, units, reportingMonths, spendCategories = [], entry, lineage = [], provenance = [] } = props;
  const mode: EntryMode = entry ? "existing" : "new";
  const [draft, setDraft] = useState<EmissionEntryDraft>(() => blankDraft(units, entry));
  const listId = useId();

  const fields = useMemo(() => buildEmissionEntryFields(category, audience, mode), [category, audience, mode]);
  const actions = useMemo(() => emissionEntryActions(audience, mode), [audience, mode]);
  const spend = isSpendKind(category);
  const reg = isRegistrationKind(category);
  const scopedTo = `Scope ${category.scope} · ${category.name}`;

  const patch = (next: Partial<EmissionEntryDraft>) => setDraft(current => ({ ...current, ...next }));
  const setMonth = (key: string, value: string) => patch({ monthly: { ...draft.monthly, [key]: value } });

  const run = (key: string) => {
    if (props.busy) return;
    if (key === "submit") return void props.onSubmit(draft);
    if (key === "save") return void props.onSubmit(draft);
    if (key === "saveDraft") return void props.onSaveDraft?.(draft);
    if (key === "reject") return void props.onReject?.();
    if (key === "approve") return void props.onApprove?.();
  };

  const onFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(audience === "portal" ? "submit" : mode === "existing" ? "approve" : "save");
  };

  return (
    <form className="nz-ef" aria-label={`${category.name} — ${mode === "new" ? "new entry" : entry?.title ?? "entry"}`} onSubmit={onFormSubmit}>
      {props.error ? <div className="nz-banner warn" role="alert">{props.error}</div> : null}
      {props.notice ? <div className="nz-banner ok" role="status">{props.notice}</div> : null}

      {fields.map(field => {
        switch (field.control) {
          case "banner":
            return (
              <div key={field.key} className="nz-banner ok nz-ef-sitebanner" role="note">
                <span>Site: <b>{site.label}</b> — this entry is allocated here.
                  <span className="chip">↦ change on the row if needed</span></span>
              </div>
            );

          case "registration":
            return (
              <fieldset key={field.key} style={{ border: 0, padding: 0, margin: 0 }}>
                <span className="nz-eyebrow">{field.label}</span>
                <div className="nz-ef-reg">
                  <label className="nz-fl">Registration (DVLA lookup)
                    <input className="nz-plate" placeholder="AB12 CDE" value={draft.registration}
                      onChange={event => patch({ registration: event.target.value.toUpperCase() })} />
                  </label>
                  <button type="button" className="nz-btn" disabled={props.busy || draft.registration.trim() === ""}
                    onClick={() => props.onLookupRegistration?.(draft.registration.trim())}>Look up</button>
                </div>
                <p className="nz-ef-manual-link">
                  …or <button type="button" onClick={() => patch({ manualMode: !draft.manualMode })}>enter manually</button> ({manualEntryHint(category)}).
                </p>
                {draft.manualMode ? (
                  <label className="nz-fl">
                    {category.kind === "commuting" ? "Mode / WFH" : category.kind === "travel" ? "Travel type" : "Make · model · fuel"}
                    <input className="nz-inp" value={draft.manualDetail} onChange={event => patch({ manualDetail: event.target.value })}
                      placeholder={category.kind === "commuting" ? "e.g. Car — diesel, 2 WFH days" : category.kind === "travel" ? "e.g. Air — short haul" : "e.g. Ford Transit, diesel"} />
                  </label>
                ) : null}
              </fieldset>
            );

          case "smart-search":
            return (
              <label key={field.key} className="nz-fl">{field.label} <span className="muted">· smart search</span>
                <input className="nz-inp" list={listId} value={draft.activity}
                  placeholder={spend ? "Search suppliers / ledger…" : "Search this category’s activities…"}
                  onChange={event => patch({ activity: event.target.value })} />
                <datalist id={listId}>{factors.map(option => <option key={option.id} value={option.label} />)}</datalist>
                <span className="nz-hint">{field.hint}</span>
              </label>
            );

          case "number":
            return field.key === "quantity" ? (
              <div key={field.key} className="nz-ef-two">
                <label className="nz-fl">{field.label}
                  <input className="nz-inp" inputMode="decimal" value={draft.quantity} placeholder={spend ? "e.g. 4,100" : "e.g. 12,400"}
                    onChange={event => patch({ quantity: event.target.value })} />
                </label>
                {spend ? (
                  <label className="nz-fl">VAT %
                    <input className="nz-inp" inputMode="decimal" value={draft.vatPercent} placeholder="20"
                      onChange={event => patch({ vatPercent: event.target.value })} />
                  </label>
                ) : (
                  <label className="nz-fl">Unit
                    <select className="nz-sel" value={draft.unit} onChange={event => patch({ unit: event.target.value })}>
                      {(units.length ? units : [draft.unit || category.code]).map(unit => <option key={unit} value={unit}>{unit}</option>)}
                    </select>
                  </label>
                )}
              </div>
            ) : null;

          case "unit-select":
            return null; // rendered alongside quantity above

          case "months":
            return (
              <details key={field.key} className="nz-disc" open={draft.monthlyOpen}
                onToggle={event => patch({ monthlyOpen: (event.target as HTMLDetailsElement).open })}>
                <summary>Add monthly breakdown <span className="muted">· optional</span></summary>
                <div className="nz-disc-body">
                  {reportingMonths.length ? (
                    <>
                      <div className="nz-months">
                        {reportingMonths.map(month => (
                          <label key={month}>{monthLabel(month)}
                            <input inputMode="decimal" value={draft.monthly[month] ?? ""} aria-label={`${monthLabel(month)} value`}
                              onChange={event => setMonth(month, event.target.value)} />
                          </label>
                        ))}
                      </div>
                      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                        <button type="button" className="nz-btn" onClick={() => {
                          const first = draft.monthly[reportingMonths[0]!] ?? "";
                          patch({ monthly: Object.fromEntries(reportingMonths.map(month => [month, first])) });
                        }}>Copy month 1 → all</button>
                        <button type="button" className="nz-btn" onClick={() => patch({ monthly: {} })}>Clear</button>
                      </div>
                    </>
                  ) : <p className="muted" style={{ margin: 0 }}>No reporting period is set for this job yet.</p>}
                  <span className="nz-hint">{field.hint}</span>
                </div>
              </details>
            );

          case "spend-group":
            return (
              <fieldset key={field.key} style={{ border: 0, padding: 0, margin: 0 }}>
                <span className="nz-eyebrow">{field.label}</span>
                <div className="nz-ef-two">
                  <label className="nz-fl">GL / nominal code
                    <input className="nz-inp" value={draft.glCode} placeholder="5200" onChange={event => patch({ glCode: event.target.value })} />
                  </label>
                  <label className="nz-fl">{audience === "portal" ? "Category (authorised)" : "PG&S category"}
                    <select className="nz-sel" value={draft.spendCategoryId} onChange={event => patch({ spendCategoryId: event.target.value })}>
                      <option value="">Select a category</option>
                      {spendCategories.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
                    </select>
                  </label>
                </div>
                <span className="nz-hint">{field.hint}</span>
              </fieldset>
            );

          case "factor-select":
            return (
              <label key={field.key} className="nz-fl">{field.label}
                <select className="nz-sel" value={draft.factorId} onChange={event => patch({ factorId: event.target.value })}>
                  <option value="">Select a factor</option>
                  {factors.map(option => <option key={option.id} value={option.id}>{option.label}{option.unit ? ` · ${option.unit}` : ""}</option>)}
                  <option value={CLIENT_FACTOR_OPTION}>Client factor (EPD)…</option>
                </select>
                <span className="nz-hint">{field.hint}</span>
              </label>
            );

          case "select":
            return field.key === "qualityTier" ? (
              <label key={field.key} className="nz-fl">Quality tier
                <select className="nz-sel" value={draft.qualityTier} onChange={event => patch({ qualityTier: event.target.value })}>
                  {QUALITY_TIERS.map(tier => <option key={tier} value={tier}>{tier}</option>)}
                </select>
              </label>
            ) : (
              <label key={field.key} className="nz-fl">Data confidence <span className="muted">· NZC-044</span>
                <select className="nz-sel" value={draft.dataConfidence} onChange={event => patch({ dataConfidence: event.target.value })}>
                  {DATA_CONFIDENCE.map(level => <option key={level} value={level}>{level}</option>)}
                </select>
              </label>
            );

          case "textarea":
            return (
              <label key={field.key} className="nz-fl">{field.label}
                <textarea className="nz-notes" rows={2} value={draft.note}
                  placeholder={audience === "portal" ? "Anything that helps the consultant verify this" : "Working note"}
                  onChange={event => patch({ note: event.target.value })} />
              </label>
            );

          case "dropzone":
            return (
              <div key={field.key}>
                <span className="nz-eyebrow">{field.label}</span>
                <div className="nz-ef-dropzone">
                  <b>📎 Attach file</b>
                  {field.hint}
                </div>
              </div>
            );

          case "lineage":
            return (
              <div key={field.key}>
                <span className="nz-eyebrow">{field.label}</span>
                <div className="nz-lin">
                  {lineage.map((step, index) => (
                    <div className="stepl" key={`${step.label}-${index}`}><b>{step.label}</b><small>{step.detail}</small></div>
                  ))}
                </div>
                {provenance.length ? (
                  <>
                    <span className="nz-eyebrow">Provenance</span>
                    {provenance.map(item => (
                      <div className="nz-kv" key={item.label}><span className="k">{item.label}</span><span className="v">{item.value}</span></div>
                    ))}
                  </>
                ) : null}
              </div>
            );

          default:
            return null;
        }
      })}

      <div className="nz-dact">
        <button type="button" className="nz-btn" onClick={props.onCancel}>Cancel</button>
        {actions.map(action => (
          <button key={action.key} type={action.variant === "primary" ? "submit" : "button"}
            className={action.variant === "primary" ? "nz-btn pri" : "nz-btn"} disabled={props.busy}
            onClick={action.variant === "primary" ? undefined : () => run(action.key)}>{action.label}</button>
        ))}
      </div>
      {audience === "portal" ? (
        <p className="nz-hint">Submitting sends this to NZI. Not counted in emissions until the consultant reviews it.</p>
      ) : null}
      <span className="nz-sr-only">{scopedTo}</span>
    </form>
  );
}
