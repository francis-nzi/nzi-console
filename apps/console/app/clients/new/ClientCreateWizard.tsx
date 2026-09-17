"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AppShell, TopBar, WorkspaceRail } from "@nzi/ui";
import { postBrowserCommand } from "@nzi/api-client";
import { NAV, USER } from "../../lib/nav";
import { crumbTrail, workspaceCrumbs } from "../../lib/crumbTrail";
import { AddressGroup, ComplianceGroup, DetailsGroup, TargetsGroup, emptyClientForm, normaliseClientForm, type ClientFormState, type FieldErrors } from "../clientForm";
import { useReferenceOptions } from "../useReferenceOptions";
import { useStaffMe } from "../../lib/useEditAccess";

const STEPS = [
  { id: "details", label: "Identity" },
  { id: "targets", label: "Targets", blurb: "The net-zero trajectory reports and portal dashboards are measured against." },
  { id: "address", label: "Address", blurb: "Registered trading address and where invoices should go." },
  { id: "compliance", label: "Compliance", blurb: "Obligations, certifications and the Scope 3 categories material to this client." },
] as const;

export function ClientCreateWizard() {
  const router = useRouter();
  // The curated lists the Identity step searches (NZC-089). Fetched once for the wizard rather
  // than per field, so the four smart-searches cannot disagree about who is on the team.
  const lookups = useReferenceOptions();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<ClientFormState>(emptyClientForm());
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const submissionKey = useRef<string | null>(null);
  const me = useStaffMe(true);

  /**
   * Client owner defaults to whoever is creating the client, and is overridable.
   *
   * Create-and-own is the common case and should cost nothing; handing a client to a colleague
   * stays a deliberate change to a field that is already filled in. Only ever fills a blank — once
   * someone has chosen an owner, this must not reach back in and change it, which is why it is
   * guarded on both the label and the id rather than on the label alone.
   *
   * If the creator is not on the roster the field stays empty and required, rather than defaulting
   * to a person who cannot be resolved.
   */
  useEffect(() => {
    if (lookups.team.state !== "ready") return;
    if (!me || me === "signed-out") return;
    if (form.owner.trim() !== "" || form.ownerUserId) return;
    const mine = lookups.team.options.find((option) => option.id === me.userId);
    if (!mine) return;
    setForm((current) =>
      current.owner.trim() === "" && !current.ownerUserId
        ? { ...current, owner: mine.label, ownerUserId: mine.id }
        : current);
  }, [lookups.team, me, form.owner, form.ownerUserId]);
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
      <TopBar searchPlaceholder="Search clients…" crumbs={crumbTrail(workspaceCrumbs("Clients", "/clients", { label: "New client", href: "/clients/new" }))} />
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
            {"blurb" in active ? <div className="sub">{active.blurb}</div> : null}
          </div>
          {step === 0 ? <DetailsGroup lookups={lookups} form={form} onChange={change} errors={errors} /> : null}
          {step === 1 ? <TargetsGroup form={form} onChange={change} errors={errors} /> : null}
          {step === 2 ? <AddressGroup form={form} onChange={change} errors={errors} /> : null}
          {step === 3 ? <ComplianceGroup form={form} onChange={change} errors={errors} /> : null}
          <div className="nz-config-actions" style={{ marginTop: 20 }}>
            <button type="button" className="nz-btn" disabled={step === 0 || saving} onClick={() => { setErrors({}); setStep((current) => Math.max(0, current - 1)); }}>Back</button>
            {last
              ? <button type="button" className="nz-btn pri" disabled={saving} onClick={submit}>{saving ? "Creating…" : "Create client"}</button>
              : <button type="button" className="nz-btn pri" onClick={next}>Continue →</button>}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
