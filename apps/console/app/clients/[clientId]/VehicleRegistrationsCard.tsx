"use client";
// Data entry D4 (R1, R8): whether this client's company-vehicle registrations are held — encrypted under the client's own key,
// never in a note — or not at all ("don't hold our reg numbers"), when vehicles are named or given a fleet number instead.
// Opting out destroys every registration already held; it is said before it is done.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { putBrowserCommand } from "@nzi/api-client";
import type { EditAccess } from "../../lib/useEditAccess";

export function VehicleRegistrationsCard({ clientId, version, optOut, access }: { clientId: string; version: number; optOut: boolean; access: EditAccess }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);

  async function save(next: boolean) {
    setBusy(true); setMessage(null);
    const result = await putBrowserCommand<{ cleared: number }>(`/api/isolated/clients/${encodeURIComponent(clientId)}/vehicle-registrations`, { optOut: next, expectedVersion: version }, crypto.randomUUID());
    setBusy(false); setConfirming(false);
    if (result.state === "success") {
      setMessage({ kind: "ok", text: next ? `Registrations are no longer held for this client${result.data.cleared ? ` — ${result.data.cleared} cleared` : ""}. Name each vehicle instead.` : "Registrations will be held, encrypted, from the next vehicle entered." });
      router.refresh();
    } else setMessage({ kind: "warn", text: result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ") : result.message });
  }

  return <section className="nz-panel nz-vehicle-regs" aria-labelledby={`vehicle-regs-${clientId}`}>
    <div className="nz-card-h"><div><span className="eyebrow">Company vehicles</span><h2 id={`vehicle-regs-${clientId}`}>Vehicle registrations</h2></div>
      <span className={`nz-st ${optOut ? "need" : "done"}`}>{optOut ? "Not held" : "Held encrypted"}</span></div>
    <div style={{ padding: "6px 16px 12px" }}>
      <p className="muted">{optOut
        ? "This client asked us not to hold registration numbers. Their vehicles are named or given a fleet number instead; a registration can still be looked up, and is not kept."
        : "A company vehicle's registration is held encrypted under this client's own key — never in a note — and identifies the vehicle year on year."}</p>
      {access.state !== "allowed" ? <p className="nz-hint">{"reason" in access ? access.reason : ""}</p>
        : optOut ? <button type="button" className="nz-btn" disabled={busy} onClick={() => void save(false)}>Hold registrations again</button>
        : confirming ? <div className="nz-vehicle-regs-confirm" role="alert">
            <p><b>Stop holding registrations?</b> Every registration held for this client is destroyed now, and cannot be recovered.</p>
            <div className="nz-config-actions"><button type="button" className="nz-btn" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
              <button type="button" className="nz-btn pri" disabled={busy} onClick={() => void save(true)}>{busy ? "Clearing…" : "Stop holding them"}</button></div>
          </div>
        : <button type="button" className="nz-btn" onClick={() => setConfirming(true)}>Don&rsquo;t hold registrations</button>}
      {message ? <div className={`nz-banner ${message.kind}`} role={message.kind === "ok" ? "status" : "alert"}>{message.text}</div> : null}
    </div>
  </section>;
}
