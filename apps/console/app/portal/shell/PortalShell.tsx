"use client";
// The portal shell (BUILD-portal-shell-lookandfeel R1, R3): MOCKUP-client-portal.html's left rail — the brand, the client, the
// job in context with a switcher, the nav groups, who is signed in — and the chosen view in the main pane. The views are the
// existing ones, unchanged (R2); the shell is only their frame. Links go through the surface, so the same shell is the client's
// portal and the staff preview (R5); in preview the rail card says so, and there is no sign-out or account to reach.
// Its stylesheet (`portal-shell.css`) is loaded where the shell is mounted — the portal layout and the preview frame.
import type { ReactNode } from "react";
import { LogoMark } from "../../lib/LogoMark";
import { useOrganisationName } from "../../lib/OrganisationNameProvider";
import { usePortalSurface } from "../portalSurface";
import { SHELL_GROUP_LABELS, shellJobLabel, shellNav, switchJobPath, type ShellGroup, type ShellJob, type ShellView } from "./shellNav";

const ICONS: Record<ShellView, ReactNode> = {
  dashboard: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  metrics: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  data: <path d="M4 6h16M4 12h16M4 18h10" />,
  strategy: <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />,
  srs: <><path d="M9 11l3 3 8-8" /><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" /></>,
  reports: <><path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /><path d="M14 3v5h5" /></>,
  messages: <path d="M4 5h16v11H8l-4 4V5Z" />,
  files: <path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" />,
  insights: <><path d="M12 3a6 6 0 0 0-4 10c1 1 1 2 1 3h6c0-1 0-2 1-3a6 6 0 0 0-4-10Z" /><path d="M9 21h6" /></>,
};

const VIEW_LABELS: Record<ShellView, string> = {
  dashboard: "Dashboard", metrics: "Metrics", data: "Data", strategy: "Strategy", srs: "SRS Readiness", reports: "Reports",
  messages: "Messages", files: "Files", insights: "Insights & Help",
};

/** Who is signed in: a client user (with their account and sign-out), or a member of staff previewing (neither). */
export type ShellPerson =
  | { kind: "client"; name: string; detail: string | null; onSignOut?: () => void; signingOut?: boolean }
  | { kind: "preview" };

export type PortalShellProps = {
  client: { name: string; logoSrc: string | null };
  jobs: readonly ShellJob[];
  jobId: string | null;
  view: ShellView;
  person: ShellPerson;
  children: ReactNode;
};

export function PortalShell({ client, jobs, jobId, view, person, children }: PortalShellProps) {
  const { link, readOnly } = usePortalSurface();
  const org = useOrganisationName();
  const items = shellNav(jobId, link);
  const groups = (["workspace", "communication", "support"] as ShellGroup[]).map((group) => ({ group, items: items.filter((item) => item.group === group) })).filter((entry) => entry.items.length);
  const job = jobs.find((entry) => entry.id === jobId) ?? null;
  const home = link("/portal");
  const account = link("/portal/account");
  const brand = (
    <>
      <span className="mk" aria-hidden="true"><svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="19" fill="#1f9d57" /><g fill="#fff"><circle cx="20" cy="15" r="5.6" /><circle cx="14.4" cy="19" r="4.6" /><circle cx="25.6" cy="19" r="4.6" /><circle cx="20" cy="20.6" r="5.6" /></g><rect x="18.6" y="23.3" width="2.8" height="8" rx="1.3" fill="#fff" /></svg></span>
      <span><b>NZ Insights Pro</b><span className="sub">Client Portal</span></span>
    </>
  );

  return (
    <div className={`nzp-app${readOnly ? " nzp-preview" : ""}`} data-portal-shell="">
      <nav className="nzp-rail" aria-label="Client portal">
        {home ? <a className="nzp-logo" href={home}>{brand}</a> : <div className="nzp-logo">{brand}</div>}
        <div className="nzp-client">
          <LogoMark src={client.logoSrc} name={client.name} className="nzp-client-mark" />
          <span><b>{client.name}</b><small>{job ? shellJobLabel(job) : "No reporting job yet"}</small></span>
        </div>
        {jobs.length > 1 ? (
          <label className="nzp-jobsel">Reporting job
            <select value={jobId ?? ""} onChange={(event) => { const href = event.target.value ? link(switchJobPath(view, event.target.value)) : null; if (href) window.location.assign(href); }}>
              {jobs.map((entry) => <option key={entry.id} value={entry.id}>{shellJobLabel(entry)} — {entry.title}</option>)}
            </select>
          </label>
        ) : null}
        {groups.map(({ group, items: groupItems }) => (
          <div key={group} role="group" aria-label={SHELL_GROUP_LABELS[group]}>
            <div className="nzp-navsec">{SHELL_GROUP_LABELS[group]}</div>
            {groupItems.map((item) => (
              <a key={item.view} className="nzp-navitem" href={item.href} aria-current={item.view === view ? "page" : undefined}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">{ICONS[item.view]}</svg>{item.label}
              </a>
            ))}
          </div>
        ))}
        <div className="nzp-spacer" />
        <div className="nzp-railcard">
          {person.kind === "preview" ? (
            <><span className="pv">● Staff preview</span><div className="who">Signed in as yourself<small>{org.short} staff · read-only preview</small></div></>
          ) : (
            <>
              <span className="pv client">● Secure client workspace</span>
              <div className="who">{person.name}{person.detail ? <small>{person.detail}</small> : null}</div>
              <div className="acts">
                {account ? <a href={account}>Security</a> : null}
                {person.onSignOut ? <button type="button" disabled={person.signingOut} onClick={person.onSignOut}>{person.signingOut ? "Signing out…" : "Sign out"}</button> : null}
              </div>
            </>
          )}
        </div>
      </nav>
      <div className="nzp-main">
        <div className="nzp-utilbar">
          <div className="nzp-crumb">{client.name}<span className="sep" aria-hidden="true">›</span>{job ? <>{job.number}<span className="sep" aria-hidden="true">›</span></> : null}<b>{VIEW_LABELS[view]}</b></div>
        </div>
        <div className="nzp-content" id="portal-main-content" tabIndex={-1}>{children}</div>
      </div>
    </div>
  );
}
