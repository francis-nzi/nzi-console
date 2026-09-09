"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AppShell, TopBar, WorkspaceRail } from "@nzi/ui";
import { postBrowserCommand } from "@nzi/api-client";
import { NAV, USER } from "../../lib/nav";
import { AddressGroup, ComplianceGroup, DetailsGroup, TargetsGroup, emptyClientForm, normaliseClientForm, type ClientFormState, type FieldErrors } from "../clientForm";

const STEPS = [
  { id: "details", label: "Identity", blurb: "Who the client is, who owns the relationship, and how they report." },
  { id: "targets", label: "Targets", blurb: "The net-zero trajectory reports and portal dashboards are measured against." },
  { id: "address", label: "Address", blurb: "Registered trading address and where invoices should go." },
  { id: "compliance", label: "Compliance", blurb: "Obligations, certifications and the Scope 3 categories material to this client." },
] as const;

export function ClientCreateWizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<ClientFormState>(emptyClientForm());
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const submissionKey = useRef<string | null>(null);
  function change(patch: Partial<ClientFormState>) {
    setForm((current) => ({ ...current, ...patch }));
    setErrors((current) => {
      const remaining = Object.entries(current).filter(([field]) => !(field in patch));
      return remaining.length === Object.keys(current).length ? current : Object.fromEntries(remaining);
    });
  }

  const identityMissing = (["name", "sector", "location", "owner"] as const).filter((field) => !form[field].trim());

  function next() {
    if (step === 0 && identityMissing.length > 0) {
      setErrors(Object.fromEntries(identityMissing.map((field) => [field, "This field is required."])));
      return;
    }
    setErrors({}); setNotice(null); setStep((current) => Math.min(current + 1, STEPS.length - 1));
  }

  async function submit() {
    setSaving(true); setNotice(null);
    submissionKey.current ??= crypto.randomUUID();
    const result = await postBrowserCommand<{ clientId: string; name: string }>("/api/isolated/commands/clients", normaliseClientForm(form), submissionKey.current);
    setSaving(false);
    if (result.state === "success") {
      submissionKey.current = null;
      router.push(`/clients/${result.data.clientId}`);
      return;
    }
    if (result.state !== "failed" || !result.retryable) submissionKey.current = null;
    if (result.state === "validation_failed") {
      setErrors(Object.fromEntries(result.issues.map((issue) => [issue.field, issue.message])));
      setNotice(result.issues[0]?.message ?? result.message);
      return;
    }
    setNotice(result.message);
  }

  const active = STEPS[step]!;
  const last = step === STEPS.length - 1;

  return (
    <AppShell rail={<WorkspaceRail sections={NAV} activeId="clients" user={USER} />}>
      <TopBar searchPlaceholder="Search clients…" crumbs={<><Link href="/clients">Clients</Link><span className="muted">/</span><b>New client</b></>} />
      <div className="nz-head">
        <div className="nz-job-titleline">
          <div>
            <div className="nz-eyebrow">New governed relationship</div>
            <h1>Add client</h1>
            <div className="sub">Creates one tenant-scoped client record and a traceable audit event.</div>
          </div>
          <Link className="nz-btn" href="/clients">Cancel</Link>
        </div>
      </div>
      <div className="nz-body" style={{ paddingTop: 16 }}>
        <ol className="nz-wizard-steps">
          {STEPS.map((entry, index) => (
            <li key={entry.id} className={index === step ? "on" : index < step ? "done" : undefined} aria-current={index === step ? "step" : undefined}>
              <i>{index < step ? "✓" : index + 1}</i><span>{entry.label}</span>
            </li>
          ))}
        </ol>
        {notice ? <div className="nz-banner warn" role="alert"><div>{notice}</div></div> : null}
        <section className="nz-panel" style={{ padding: 20 }}>
          <div style={{ marginBottom: 16 }}>
            <span className="nz-eyebrow">Step {step + 1} of {STEPS.length}</span>
            <h2 style={{ fontSize: 17, margin: "4px 0 2px" }}>{active.label}</h2>
            <div className="sub">{active.blurb}</div>
          </div>
          {step === 0 ? <DetailsGroup form={form} onChange={change} errors={errors} /> : null}
          {step === 1 ? <TargetsGroup form={form} onChange={change} errors={errors} /> : null}
          {step === 2 ? <AddressGroup form={form} onChange={change} errors={errors} /> : null}
          {step === 3 ? <ComplianceGroup form={form} onChange={change} errors={errors} /> : null}
          <div className="nz-config-actions" style={{ marginTop: 20 }}>
            <button type="button" className="nz-btn" disabled={step === 0 || saving} onClick={() => { setErrors({}); setStep((current) => Math.max(0, current - 1)); }}>Back</button>
            {last
              ? <button type="button" className="nz-btn pri" disabled={saving} onClick={submit}>{saving ? "Creating…" : "Create client"}</button>
              : <button type="button" className="nz-btn pri" onClick={next}>Continue →</button>}
          </div>
          {!last ? <p className="sub" style={{ margin: "10px 2px 0" }}>Only identity is required — later steps can be completed now or from the client&apos;s edit tabs afterwards.</p> : null}
        </section>
      </div>
    </AppShell>
  );
}
