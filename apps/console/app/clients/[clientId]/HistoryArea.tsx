"use client";

import { useState } from "react";
import { Drawer } from "@nzi/ui";
import type { ScreenResult } from "@nzi/contracts";
import type { ClientHistoryEntry } from "@nzi/isolated-backend";

/**
 * The client's History (CLIENT-12): every audited change to this client, its sites, contacts, targets, strategies and
 * jobs, newest first — who, what, when — each opening the full audit record (before, after, and the reason where one
 * was given). Read-only: an audit record is never edited. In the workspace's own list and drawer idiom — the admin
 * pilot's styling is scoped to /admin (NZC-167).
 *
 * Resolved with the rest of the client page, under the caller's audit.view; the area is only offered to a holder who
 * may read this client's history, and a refusal (403) is shown as one — never as an empty or a failed history.
 */
type HistoryPayload = { history: ClientHistoryEntry[]; limit: number };

const PHRASES: Array<[RegExp, string]> = [
  [/^client_created$/, "created the client"],
  [/^client_updated$/, "edited the client record"],
  [/^client_logo_set$/, "set the logo"],
  [/^client_logo_removed$/, "removed the logo"],
  [/^client_targets_set$/, "set the targets"],
  [/^client_contact_created$/, "added a contact"],
  [/^client_contact_updated$/, "edited a contact"],
  [/^client_contact_deactivated$/, "removed a contact"],
  [/^client_contact_consent_recorded$/, "recorded a contact's consent"],
  [/^client_rebaselined$/, "re-baselined"],
  [/^client_site_created$/, "added a site"],
  [/^client_site_updated$/, "edited a site"],
  [/^client_site_vacated$/, "vacated a site"],
  [/^client_site_reinstated$/, "reinstated a site"],
  [/^client_site_floor_area_recorded$/, "recorded a site's floor area"],
  [/^client_site_registered_office_changed$/, "moved the registered office"],
  [/^job_created$/, "created a job"],
  [/^job_stage_changed$/, "moved a job to another stage"],
  [/^report_published$/, "released a report"],
  [/^portal_access_granted$/, "granted portal access"],
];
/** A recognised action in words; any other is shown as its code, words split, rather than guessed at. */
const phrase = (action: string) => PHRASES.find(([pattern]) => pattern.test(action))?.[1] ?? action.replace(/^client[._]/, "").replace(/[._]+/g, " ");
const actor = (entry: ClientHistoryEntry) => entry.actorLabel ?? (entry.actorId.startsWith("import:") ? "System import" : entry.actorId);
const initials = (name: string) => name.split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase() || "·";
const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" });
const json = (value: unknown) => value === null || value === undefined ? null : typeof value === "string" ? value : JSON.stringify(value, null, 2);

function Kv({ label, value }: { label: string; value: string }) { return <div className="nz-kv"><span className="k">{label}</span><span className="v" style={{ overflowWrap: "anywhere" }}>{value}</span></div>; }

export function HistoryArea({ result }: { result: ScreenResult<HistoryPayload> }) {
  const [open, setOpen] = useState<ClientHistoryEntry | null>(null);
  const denied = result.state === "failed" && result.error.code === "HTTP_403";
  const history = result.state === "success" || result.state === "degraded" ? result.data.history : [];
  const limit = result.state === "success" || result.state === "degraded" ? result.data.limit : 0;

  return <section className="nz-panel" aria-labelledby="area-history">
    <div className="nz-card-h"><span className="eyebrow">Record</span><h2 id="area-history">History</h2></div>
    <div className="nz-card-b">
      {result.state === "loading" ? <p className="sub" role="status">Loading the client&apos;s history…</p> : null}
      {denied ? <p className="sub" role="status">Your role does not include reading this client&apos;s history — it needs the audit.view permission, and for a Consultant or Finance user, to be the client&apos;s owner.</p> : null}
      {result.state === "failed" && !denied ? <div className="nz-banner warn" role="alert">The client&apos;s history could not be loaded. Nothing is shown rather than an incomplete record.</div> : null}
      {result.state === "empty" ? <p className="sub">No changes are recorded for this client yet.</p> : null}
      {history.length > 0 ? <>
        {history.map((entry) => <div key={entry.id} className="nz-lrow">
          <button type="button" className="nz-lrow-open" onClick={() => setOpen(entry)} aria-label={`${actor(entry)} ${phrase(entry.action)} — ${when.format(new Date(entry.at))}. Open the audit record`}>
            <span className="ic" aria-hidden="true">{initials(actor(entry))}</span>
            <span className="main">
              <span className="nm"><span><b>{actor(entry)}</b> {phrase(entry.action)}</span></span>
              <span className="sub" style={{ display: "block" }}>{when.format(new Date(entry.at))} · {entry.entity}{entry.reason ? ` · “${entry.reason}”` : ""}</span>
            </span>
          </button>
        </div>)}
        {history.length >= limit ? <p className="nz-maps">The latest {limit} changes are shown.</p> : null}
      </> : null}
    </div>
    <Drawer open={open !== null} onClose={() => setOpen(null)} ariaLabel={open ? `Audit record: ${phrase(open.action)}` : "Audit record"} className="nz-site-drawer" dismissOnOutsideClick>
      {open ? <>
        <div className="nz-dh"><div className="k">Audit record</div><h3>{phrase(open.action)}</h3><button type="button" className="x" onClick={() => setOpen(null)} aria-label="Close">×</button></div>
        <div className="nz-db">
          <Kv label="Who" value={actor(open)} />
          <Kv label="When" value={when.format(new Date(open.at))} />
          <Kv label="Action" value={open.action} />
          <Kv label="Record" value={`${open.entity} · ${open.entityId}`} />
          <Kv label="Correlation" value={open.correlationId} />
          {open.reason ? <Kv label="Reason" value={open.reason} /> : null}
          {json(open.before) ? <div className="nz-fl" style={{ marginTop: 12 }}><span>Before</span><pre className="nz-audit-pre">{json(open.before)}</pre></div> : null}
          {json(open.after) ? <div className="nz-fl" style={{ marginTop: 12 }}><span>After</span><pre className="nz-audit-pre">{json(open.after)}</pre></div> : null}
          <span className="nz-hint" style={{ marginTop: 12 }}>Audit records are append-only — never edited.</span>
        </div>
        <div className="nz-df"><span className="sp" /><button type="button" className="nz-btn" onClick={() => setOpen(null)}>Close</button></div>
      </> : null}
    </Drawer>
  </section>;
}
