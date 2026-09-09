"use client";

// The client record's field groups, shared by the create wizard (/clients/new)
// and the edit tabs (/clients/[id]/edit) so the two surfaces cannot drift.
import { InfoTip } from "@nzi/ui";
import {
  clientCertifications, clientGroupStructures, clientReportingFrameworks, clientReportingFrequencies,
  emissionCategoryTaxonomy,
  type ClientIdentityFields, type ClientProfileFields,
} from "@nzi/contracts";

export type ClientFormState = ClientIdentityFields & ClientProfileFields;
export type FieldErrors = Record<string, string>;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const CURRENCIES = ["GBP", "EUR", "USD", "AUD", "CAD", "CHF", "NZD", "SEK", "NOK", "DKK", "JPY", "SGD"];
const FREQUENCY_LABEL: Record<string, string> = { annual: "Annual (default)", quarterly: "Quarterly", monthly: "Monthly" };
const STRUCTURE_LABEL: Record<string, string> = { standalone: "Standalone", subsidiary: "Subsidiary", parent: "Parent company", "joint-venture": "Joint venture" };
const SCOPE3 = emissionCategoryTaxonomy.filter((entry) => entry.scope === "3");

export function emptyClientForm(): ClientFormState {
  return {
    name: "", status: "onboarding", sector: "", location: "", owner: "",
    dataReportingFrequency: "annual", currency: "GBP", billingSameAsRegistered: true,
    reportingFrameworks: [], certifications: [], primaryScope3Categories: [],
  };
}

/** Blank strings are how an emptied text input reads; the command layer wants null. */
export function normaliseClientForm(form: ClientFormState): ClientFormState {
  const blanked = Object.fromEntries(
    Object.entries(form).map(([key, value]) => [key, typeof value === "string" && value.trim() === "" && !["name", "status", "sector", "location", "owner"].includes(key) ? null : value]),
  );
  return blanked as ClientFormState;
}

type GroupProps = { form: ClientFormState; onChange: (patch: Partial<ClientFormState>) => void; errors: FieldErrors };

/**
 * Hint and error text are wired through aria-describedby rather than nested in the
 * <label>, so an input's accessible name stays the field name alone.
 */
function Field({ label, name, errors, control, hint, span, required }: {
  label: string; name: string; errors: FieldErrors; hint?: string; span?: number; required?: boolean;
  control: (a11y: { id: string; "aria-describedby": string | undefined; "aria-invalid": true | undefined; required?: boolean }) => React.ReactNode;
}) {
  const id = `client-${name}`;
  const error = errors[name];
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="nz-fl" style={{ margin: 0, ...(span ? { gridColumn: `span ${span}` } : {}) }}>
      <label htmlFor={id}>{label}{required ? <span className="req" aria-hidden="true">*</span> : null}</label>
      {control({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined, required })}
      {error ? <small className="nz-hint" id={`${id}-error`} role="alert" style={{ color: "var(--coral)" }}>{error}</small> : null}
      {hint ? <small className="nz-hint" id={`${id}-hint`}>{hint}</small> : null}
    </div>
  );
}

function Text({ form, onChange, errors, name, label, hint, span, type = "text", placeholder, required }: GroupProps & { name: keyof ClientFormState; label: string; hint?: string; span?: number; type?: string; placeholder?: string; required?: boolean }) {
  return (
    <Field label={label} name={String(name)} errors={errors} hint={hint} span={span} required={required}
      control={(a11y) => (
        <input {...a11y} className="nz-inp" type={type} placeholder={placeholder}
          value={(form[name] as string | null) ?? ""}
          onChange={(event) => onChange({ [name]: event.target.value } as Partial<ClientFormState>)} />
      )} />
  );
}

function Num({ form, onChange, errors, name, label, hint, span, step, min, max, placeholder }: GroupProps & { name: keyof ClientFormState; label: string; hint?: string; span?: number; step?: string; min?: number; max?: number; placeholder?: string }) {
  return (
    <Field label={label} name={String(name)} errors={errors} hint={hint} span={span}
      control={(a11y) => (
        <input {...a11y} className="nz-inp" type="number" step={step} min={min} max={max} placeholder={placeholder}
          value={(form[name] as number | null) ?? ""}
          onChange={(event) => onChange({ [name]: event.target.value === "" ? null : Number(event.target.value) } as Partial<ClientFormState>)} />
      )} />
  );
}

function CheckGroup({ legend, hint, options, selected, onToggle, columns = 3 }: { legend: string; hint: string; options: readonly { value: string; label: string }[]; selected: string[]; onToggle: (next: string[]) => void; columns?: number }) {
  return (
    <fieldset className="nz-checkgroup">
      <legend>{legend}<small className="nz-hint">{hint}</small></legend>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 8 }}>
        {options.map((option) => (
          <label key={option.value} className="nz-checkcard">
            <input type="checkbox" checked={selected.includes(option.value)}
              onChange={(event) => onToggle(event.target.checked ? [...selected, option.value] : selected.filter((entry) => entry !== option.value))} />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function DetailsGroup(props: GroupProps) {
  const { form, onChange, errors } = props;
  return (
    <>
      <div className="nz-client-create-grid">
        <Text {...props} name="name" label="Client name" required />
        <Text {...props} name="portfolio" label="Portfolio" />
        <Text {...props} name="owner" label="Client owner" required />
        <Text {...props} name="clientManager" label="Client manager" />
        <Field label="Relationship stage" name="status" errors={errors} hint="Controls portfolio health and job eligibility."
          control={(a11y) => (
            <select {...a11y} className="nz-sel" value={form.status} onChange={(event) => onChange({ status: event.target.value as ClientFormState["status"] })}>
              <option value="onboarding">Onboarding</option><option value="active">Active</option>
              <option value="at-risk">At risk</option><option value="prospect">Prospect</option>
            </select>
          )} />
        <Text {...props} name="website" label="Website" placeholder="https://example.com" />
        <Text {...props} name="sector" label="Industry" required />
        <Text {...props} name="industrySic" label="Industry code (SIC)" />
        <Text {...props} name="referral" label="Referral" />
        <Text {...props} name="companyRegistration" label="Company registration" />
        <Text {...props} name="headquarters" label="Headquarters" />
        <Text {...props} name="location" label="Location" placeholder="City, country" required />
        <Field label="Financial year end" name="financialYearEndMonth" errors={errors}
          control={(a11y) => (
            <select {...a11y} className="nz-sel" value={form.financialYearEndMonth ?? ""} onChange={(event) => onChange({ financialYearEndMonth: event.target.value === "" ? null : Number(event.target.value) })}>
              <option value="">Not set</option>
              {MONTHS.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}
            </select>
          )} />
        <Field label="Data reporting frequency" name="dataReportingFrequency" errors={errors} hint="Controls which view opens first on the portal's Data Completeness tab. Monthly detail is always available as a drill-down either way."
          control={(a11y) => (
            <select {...a11y} className="nz-sel" value={form.dataReportingFrequency ?? "annual"} onChange={(event) => onChange({ dataReportingFrequency: event.target.value as ClientFormState["dataReportingFrequency"] })}>
              {clientReportingFrequencies.map((entry) => <option key={entry} value={entry}>{FREQUENCY_LABEL[entry]}</option>)}
            </select>
          )} />
        <Field label="Currency" name="currency" errors={errors}
          control={(a11y) => (
            <select {...a11y} className="nz-sel" value={form.currency ?? "GBP"} onChange={(event) => onChange({ currency: event.target.value })}>
              {CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          )} />
        <Text {...props} name="logoUrl" label="Logo URL" span={3} placeholder="https://…" hint="Used on reports and the client portal." />
      </div>
      {form.logoUrl?.trim() ? (
        <div className="nz-logo-preview">
          <span className="nz-eyebrow">Logo preview</span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={form.logoUrl} alt={`${form.name || "Client"} logo`} />
        </div>
      ) : null}
      <div style={{ marginTop: 15 }}>
        <Field label="Company description" name="companyDescription" errors={errors}
          control={(a11y) => (
            <textarea {...a11y} className="nz-inp" rows={3} value={form.companyDescription ?? ""} placeholder="Brief description of the company…"
              onChange={(event) => onChange({ companyDescription: event.target.value })} />
          )} />
      </div>
      <div className="nz-client-create-grid" style={{ marginTop: 4 }}>
        <Text {...props} name="contactName" label="Primary contact" />
        <Text {...props} name="contactRole" label="Contact role" />
        <Text {...props} name="contactEmail" label="Contact email" type="email" />
      </div>
    </>
  );
}

export function TargetsGroup(props: GroupProps) {
  const { form, onChange, errors } = props;
  return (
    <>
      <div className="nz-client-create-grid">
        <Num {...props} name="netZeroTargetYear" label="Net zero target year" placeholder="2045" />
        <Num {...props} name="netZeroTargetReductionPct" label="Net zero target reduction %" step="any" min={0} max={100} placeholder="90" hint="Default 90% in line with Net Zero requirements." />
      </div>
      <fieldset className="nz-fieldset accent">
        <legend>Baseline period (financial year)<small className="nz-hint">The benchmark reporting period. Subsequent annual jobs follow this structure.</small></legend>
        <div className="nz-client-create-grid">
          <Field label="Baseline period start" name="baselinePeriodStart" errors={errors}
            control={(a11y) => <input {...a11y} className="nz-inp" type="date" value={form.baselinePeriodStart ?? ""} onChange={(event) => onChange({ baselinePeriodStart: event.target.value || null })} />} />
          <Field label="Baseline period end" name="baselinePeriodEnd" errors={errors}
            control={(a11y) => <input {...a11y} className="nz-inp" type="date" value={form.baselinePeriodEnd ?? ""} onChange={(event) => onChange({ baselinePeriodEnd: event.target.value || null })} />} />
        </div>
      </fieldset>
      <fieldset className="nz-fieldset">
        <legend>Historical baseline emissions<small className="nz-hint">Third-party benchmark values so reports can compare against the client&apos;s own baseline.</small></legend>
        <div className="nz-client-create-grid">
          <Num {...props} name="baselineScope1Tco2e" label="Baseline Scope 1" step="any" min={0} placeholder="123.4" />
          <Num {...props} name="baselineScope2Tco2e" label="Baseline Scope 2" step="any" min={0} placeholder="456.7" />
          <Num {...props} name="baselineScope3Tco2e" label="Baseline Scope 3" step="any" min={0} placeholder="789.0" />
          <Num {...props} name="baselineTotalTco2e" label="Baseline total" step="any" min={0} placeholder="1369.1" />
        </div>
      </fieldset>
      <fieldset className="nz-fieldset">
        <legend>Interim targets<small className="nz-hint">Scope 1, 2 and 3 interim target years and reduction percentages.</small></legend>
        <div className="nz-client-create-grid">
          {([1, 2, 3] as const).map((scope) => (
            <div key={scope} style={{ display: "contents" }}>
              <Num {...props} name={`scope${scope}InterimYear` as keyof ClientFormState} label={`Scope ${scope} interim target year`} placeholder="2035" />
              <Num {...props} name={`scope${scope}InterimReductionPct` as keyof ClientFormState} label={`Scope ${scope} interim reduction %`} step="any" min={0} max={100} placeholder="50" />
            </div>
          ))}
        </div>
      </fieldset>
    </>
  );
}

export function AddressGroup(props: GroupProps) {
  const { form, onChange, errors } = props;
  return (
    <>
      <fieldset className="nz-fieldset">
        <legend>Registered / trading address<small className="nz-hint">The client&apos;s primary registered or trading address.</small></legend>
        <div className="nz-client-create-grid">
          <Text {...props} name="registeredAddressLine1" label="Address line 1" span={3} />
          <Text {...props} name="registeredAddressLine2" label="Address line 2" span={3} />
          <Text {...props} name="registeredCity" label="City" />
          <Text {...props} name="registeredRegion" label="Region / county" />
          <Text {...props} name="registeredPostcode" label="Postcode" />
          <Text {...props} name="registeredCountry" label="Country" />
        </div>
      </fieldset>
      <fieldset className="nz-fieldset">
        <legend>Billing address<small className="nz-hint">Use this only if invoices should go to a different address.</small></legend>
        <label className="nz-checkcard" style={{ marginBottom: 12 }}>
          <input type="checkbox" checked={form.billingSameAsRegistered ?? true}
            onChange={(event) => onChange({ billingSameAsRegistered: event.target.checked })} />
          <span>Billing address same as registered address</span>
        </label>
        <div className="nz-client-create-grid">
          <Text {...props} name="billingCompany" label="Billing company" span={3} hint="Defaults to the client name, but you can override it for invoicing." />
          {form.billingSameAsRegistered === false ? (
            <>
              <Text {...props} name="billingAddressLine1" label="Address line 1" span={3} />
              <Text {...props} name="billingAddressLine2" label="Address line 2" span={3} />
              <Text {...props} name="billingCity" label="City" />
              <Text {...props} name="billingRegion" label="Region / county" />
              <Text {...props} name="billingPostcode" label="Postcode" />
              <Text {...props} name="billingCountry" label="Country" />
            </>
          ) : null}
        </div>
      </fieldset>
    </>
  );
}

export function ComplianceGroup(props: GroupProps) {
  const { form, onChange, errors } = props;
  return (
    <>
      <div className="nz-client-create-grid">
        <Text {...props} name="parentCompany" label="Parent company / group name" placeholder="e.g. Acme Group plc" />
        <Field label="Group structure" name="groupStructure" errors={errors}
          control={(a11y) => (
            <select {...a11y} className="nz-sel" value={form.groupStructure ?? ""} onChange={(event) => onChange({ groupStructure: (event.target.value || null) as ClientFormState["groupStructure"] })}>
              <option value="">Not specified</option>
              {clientGroupStructures.map((entry) => <option key={entry} value={entry}>{STRUCTURE_LABEL[entry]}</option>)}
            </select>
          )} />
      </div>
      <CheckGroup legend="Reporting obligations & frameworks" hint="Select all that apply."
        options={clientReportingFrameworks.map((entry) => ({ value: entry, label: entry }))}
        selected={form.reportingFrameworks ?? []} onToggle={(next) => onChange({ reportingFrameworks: next })} />
      <CheckGroup legend="Certifications & commitments" hint="Select all that apply."
        options={clientCertifications.map((entry) => ({ value: entry, label: entry }))}
        selected={form.certifications ?? []} onToggle={(next) => onChange({ certifications: next })} columns={4} />
      <CheckGroup legend="Primary Scope 3 categories" hint="Select the categories material to this client."
        options={SCOPE3.map((entry) => ({ value: entry.code, label: `Cat ${entry.code.slice(2)}: ${entry.name}` }))}
        selected={form.primaryScope3Categories ?? []} onToggle={(next) => onChange({ primaryScope3Categories: next })} columns={2} />
      <p className="sub" style={{ display: "flex", alignItems: "center", gap: 6, margin: "14px 2px 0" }}>
        Used to ground AI-assisted narrative and report section defaults.
        <InfoTip label="How compliance context is used">
          These selections are advisory context for narrative and section defaults. They never substitute for the measured evidence base, and no figure is derived from them.
        </InfoTip>
      </p>
    </>
  );
}
