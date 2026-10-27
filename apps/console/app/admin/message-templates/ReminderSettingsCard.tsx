"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { putBrowserCommand } from "@nzi/api-client";
import { isReminderLead, STRATEGY_REMINDER_MAX_LEAD_DAYS, type ReminderSettings } from "@nzi/contracts";
import { AuditLine, NumberField, Switch } from "@nzi/ui";

/**
 * Reminders to action owners (Actions A3, R6), beside the message templates that word them: the master switch and the
 * default lead. Off, no reminder is sent at all — the owner's before a target date, or the overdue one. A consultant can
 * set an action's own lead on the plan; this is the default for every action that has none.
 */
export function ReminderSettingsCard({ settings, editing }: { settings: ReminderSettings; editing: { allowed: true } | { allowed: false; reason: string } }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [lead, setLead] = useState(String(settings.defaultLeadDays));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const key = useRef<string | null>(null);
  const readOnly = !editing.allowed;
  const leadDays = Number(lead);
  const changed = enabled !== settings.enabled || lead.trim() !== String(settings.defaultLeadDays);

  async function save() {
    if (saving) return;
    if (lead.trim() === "" || !isReminderLead(leadDays)) { setError(`The default lead is a whole number of days, from 0 to ${STRATEGY_REMINDER_MAX_LEAD_DAYS}.`); return; }
    setSaving(true); setError(null); setNotice(null);
    try {
      const result = await putBrowserCommand("/api/isolated/reminder-settings",
        { enabled, defaultLeadDays: leadDays, expectedVersion: settings.version }, key.current ??= crypto.randomUUID());
      key.current = null;
      if (result.state !== "success") {
        setError(result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ")
          : result.state === "conflict" ? "The settings changed since this page loaded. Reload to see the latest." : result.message);
        return;
      }
      setNotice(enabled ? `Reminders are on: owners hear ${leadDays} day${leadDays === 1 ? "" : "s"} before an action's target date, unless the action sets its own.` : "Reminders are off: none is sent.");
      router.refresh();
    } finally { setSaving(false); }
  }

  return <section className="nz-a-card nz-a-reminders" aria-labelledby="reminders-title">
    <div className="nz-a-panel-title">
      <h2 id="reminders-title">Reminders to action owners</h2>
      <span className={`nz-a-badge${settings.enabled ? " ok" : ""}`}><i aria-hidden="true" />{settings.enabled ? `On · ${settings.defaultLeadDays} day${settings.defaultLeadDays === 1 ? "" : "s"} before` : "Off"}</span>
    </div>
    <div className="nz-a-reminders-b">
      <p className="nz-a-hint">Before a reduction action's target date, its owner — a client contact who has consented to email — is reminded, once, with a link to their plan in the portal. Only Agreed and In progress actions remind. The wording is the “Reduction action — reminder to its owner before the target date” message below.</p>
      {error ? <div className="nz-a-error" role="alert">{error}</div> : null}
      {notice ? <div className="nz-a-notice" role="status">{notice}</div> : null}
      <Switch label="Send reminders" description="Off, no reminder is sent — before a target date or after one." checked={enabled} disabled={readOnly || saving} onChange={setEnabled} />
      <NumberField label="Default lead (days before the target date)" hint={`0 to ${STRATEGY_REMINDER_MAX_LEAD_DAYS}. An action can set its own on the client's plan.`}
        value={lead} min={0} max={STRATEGY_REMINDER_MAX_LEAD_DAYS} step={1} disabled={readOnly || saving} onChange={setLead} />
      <div className="nz-a-sub-record-actions">
        <AuditLine version={settings.version ?? "new"}>{readOnly ? editing.reason : undefined}</AuditLine>
        {readOnly ? null : <button type="button" className="nz-a-btn pri" onClick={save} disabled={saving || !changed}>{saving ? "Saving…" : "Save"}</button>}
      </div>
    </div>
  </section>;
}
