"use client";

import { useState } from "react";
import { AuditLine, DrawerEditor } from "@nzi/ui";
import type { AdminChange } from "@nzi/isolated-backend";

/**
 * Recent administration changes (admin Phase A1), each opening the design's side panel with the full audit record —
 * who, what, when, the correlation that ties it to its run or command, the reason, and the before and after. Read-only:
 * the panel has no actions, because an audit record is never edited.
 */
const PHRASES: Array<[RegExp, string]> = [
  [/^reference\.values\.imported$/, "imported reference values"],
  [/^reference\.value\.created$/, "added a lookup value"],
  [/^reference\.value\.updated$/, "edited a lookup value"],
  [/^reference\.value\.deactivated$/, "deactivated a lookup value"],
  [/^reference\.value\.reinstated$/, "reinstated a lookup value"],
  [/^team\.roster\.imported$/, "imported the team roster"],
  [/^milestones\.imported$/, "backfilled milestones from v7"],
  [/^staff\.invite/, "invited a staff member"],
  [/^staff\.enrolment\.issue$/, "issued a sign-in enrolment"],
  [/^staff\.enrolment\.revoke$/, "revoked a sign-in enrolment"],
  [/^staff\.role\./, "changed a staff role"],
  [/^strategy\.library\.deactivat/, "deactivated a strategy in the library"],
  [/^strategy\.library\./, "updated the strategy library"],
  [/^factor\.variant\.added$/, "added a factor category variant"],
  [/^factor\.variant\.relabelled$/, "relabelled a factor category variant"],
  [/^factor\.variant\.retired$/, "retired a factor category variant"],
];
const phrase = (action: string) => PHRASES.find(([pattern]) => pattern.test(action))?.[1] ?? action;
const actor = (change: AdminChange) => change.actorLabel ?? (change.actorId.startsWith("import:") ? "System import" : change.actorId);
const initials = (name: string) => name.split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase() || "·";
const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" });
const json = (value: unknown) => value === null || value === undefined ? null : typeof value === "string" ? value : JSON.stringify(value, null, 2);

export function AdminChangesFeed({ changes }: { changes: AdminChange[] }) {
  const [open, setOpen] = useState<AdminChange | null>(null);
  if (changes.length === 0) return <p className="nz-a-empty">No administration changes are recorded yet.</p>;
  return <>
    <ul className="nz-a-feed">
      {changes.map((change) => <li key={change.id}>
        <button type="button" onClick={() => setOpen(change)} aria-label={`${actor(change)} ${phrase(change.action)} — ${when.format(new Date(change.at))}. Open the audit record`}>
          <span className="dot" aria-hidden="true">{initials(actor(change))}</span>
          <span><span className="t"><b>{actor(change)}</b> {phrase(change.action)}</span><span className="m" style={{ display: "block" }}>{when.format(new Date(change.at))} · {change.entity}</span></span>
        </button>
      </li>)}
    </ul>
    <DrawerEditor open={open !== null} onClose={() => setOpen(null)} eyebrow="Audit record" title={open ? phrase(open.action) : ""}
      audit={<AuditLine>Audit records are append-only — never edited</AuditLine>}>
      {open ? <>
        <dl className="nz-a-detail">
          <dt>Who</dt><dd>{actor(open)}</dd>
          <dt>When</dt><dd>{when.format(new Date(open.at))}</dd>
          <dt>Action</dt><dd className="nz-a-mono">{open.action}</dd>
          <dt>Record</dt><dd className="nz-a-mono">{open.entity} · {open.entityId}</dd>
          <dt>Correlation</dt><dd className="nz-a-mono">{open.correlationId}</dd>
          {open.reason ? <><dt>Reason</dt><dd>{open.reason}</dd></> : null}
        </dl>
        {json(open.before) ? <div><div className="nz-a-eyebrow" style={{ marginBottom: 6 }}>Before</div><pre className="nz-a-pre">{json(open.before)}</pre></div> : null}
        {json(open.after) ? <div><div className="nz-a-eyebrow" style={{ marginBottom: 6 }}>After</div><pre className="nz-a-pre">{json(open.after)}</pre></div> : null}
      </> : null}
    </DrawerEditor>
  </>;
}
