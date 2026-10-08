"use client";

// Phase 3a (0161, ruled 8 Oct 2026) — the job shell's Sites drawer: which of the client's sites this job reports on.
// Each site is Included until the job leaves it out; leaving one out asks why, and is refused while the job uses the
// site (its message is shown as the server gives it). Sites themselves are the client's, edited there (ruled 7 Oct).
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { putBrowserCommand, putBrowserCommandWithReason, type BrowserCommandResult } from "@nzi/api-client";
import type { SiteOption } from "@nzi/contracts";

const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;

export function JobSitesDrawer({ jobId, clientId, sites, writeEnabled }: { jobId: string; clientId: string; sites: SiteOption[]; writeEnabled: boolean }) {
  const router = useRouter();
  const [leaving, setLeaving] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ siteId: string; text: string } | null>(null);
  const idempotency = useRef<{ siteId: string; key: string } | null>(null);

  async function decide(site: SiteOption, included: boolean) {
    setPending(site.id); setError(null);
    // One key per attempt at one decision; a failure releases it so a corrected retry is a new command.
    if (idempotency.current?.siteId !== site.id) idempotency.current = { siteId: site.id, key: crypto.randomUUID() };
    const path = `/api/isolated/jobs/${encodeURIComponent(jobId)}/sites/${encodeURIComponent(site.id)}/inclusion`;
    const body = { included, expectedVersion: site.inclusionVersion ?? 0 };
    const result = included
      ? await putBrowserCommand<{ version: number }>(path, body, idempotency.current.key)
      : await putBrowserCommandWithReason<{ version: number }>(path, body, idempotency.current.key, reason.trim());
    setPending(null);
    idempotency.current = null;
    if (result.state === "success") { setLeaving(null); setReason(""); router.refresh(); }
    else setError({ siteId: site.id, text: errorText(result) });
  }

  return <>
    {sites.length ? <ul className="nz-shell-sites" aria-label="Sites in this job">{sites.map((site) => {
      const included = site.included !== false;
      return <li key={site.id} className="nz-shell-site">
        <div className="nz-shell-site-row">
          <b>{site.name}</b>
          <span className="nz-shell-site-actions">
            <span className={`nz-st ${included ? "done" : "nof"}`}>{included ? "Included" : "Left out"}</span>
            {writeEnabled && leaving !== site.id ? (included
              ? <button type="button" className="nz-btn sm" disabled={pending !== null} onClick={() => { setLeaving(site.id); setReason(""); setError(null); }}>Leave out…</button>
              : <button type="button" className="nz-btn sm" disabled={pending !== null} onClick={() => void decide(site, true)}>{pending === site.id ? "Including…" : "Include"}</button>) : null}
          </span>
        </div>
        {!included && site.exclusionReason ? <p className="nz-hint">Left out: {site.exclusionReason}</p> : null}
        {leaving === site.id ? <div className="nz-shell-site-confirm">
          <label className="nz-fl">Why is {site.name} left out of this job?
            <input className="nz-inp" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. sold before the reporting year" autoFocus />
          </label>
          <span className="nz-shell-site-actions">
            <button type="button" className="nz-btn" disabled={pending !== null} onClick={() => { setLeaving(null); setError(null); }}>Cancel</button>
            <button type="button" className="nz-btn pri" disabled={pending !== null || !reason.trim()} onClick={() => void decide(site, false)}>{pending === site.id ? "Leaving out…" : "Leave out"}</button>
          </span>
        </div> : null}
        {error?.siteId === site.id ? <p className="nz-hint bad" role="alert">{error.text}</p> : null}
      </li>;
    })}</ul>
      : <p className="nz-hint">This client has no sites in use. Entries without a site stay visible as Unallocated.</p>}
    <p className="nz-hint">Every site the client has in use is in this job unless it is left out here. A site with entries can&rsquo;t be left out — move or remove them first. Archived sites are not listed.</p>
    {/* Sites belong to the client (Phase 1), so they are added and edited there, not from inside a job (ruled 7 Oct). */}
    <div><a className="nz-btn" href={`/clients/${encodeURIComponent(clientId)}#client-sites`}>Manage sites on the client</a></div>
  </>;
}
