import type { ReactNode } from "react";
import type { ScreenResult } from "@nzi/contracts";
import { AppShell, TopBar, WorkspaceRail } from "@nzi/ui";
import { NAV, USER } from "./nav";
import { crumbTrail, workspaceCrumbs } from "./crumbTrail";

type StateKind = "loading" | "empty" | "failed";

/**
 * Where a state card sits when the page is a staff workspace: which rail item is current, and the crumb to show.
 *
 * Without it a loading, empty or failed state is a bare card with no navigation — which is how a new organisation,
 * with no clients yet, landed on a Control Room it could not leave. Every page that renders AppShell when it has data
 * passes this, so the rail and the top bar are there whatever state the data is in. Pages with no app chrome by
 * design (the report and portal previews, the printable report) leave it out.
 */
export type ScreenChrome = { activeId: string; label: string; href: string };

export function ScreenState<T>({ result, chrome, children }: { result: ScreenResult<T>; chrome?: ScreenChrome; children: (data: T, warning?: string) => ReactNode }) {
  if (result.state === "success" || result.state === "degraded") {
    return <>{result.state === "degraded" ? <aside className="nz-degraded-state" role="status"><span className="nz-state-icon">!</span><div><b>Some data may be incomplete</b><p>{result.warning.message}</p><small>Reference {result.warning.correlationId ?? result.meta.requestId}</small></div></aside> : null}{children(result.data, result.state === "degraded" ? result.warning.message : undefined)}</>;
  }
  const card = result.state === "loading" ? <State kind="loading" title="Loading workspace" detail="The requested screen data is being retrieved." inShell={!!chrome} />
    : result.state === "empty" ? <State kind="empty" title="Nothing here yet" detail={result.message} inShell={!!chrome} />
    : <State kind="failed" title="Workspace unavailable" detail={result.error.message} reference={result.error.correlationId ?? result.meta.requestId} inShell={!!chrome} />;
  if (!chrome) return card;
  return <AppShell rail={<WorkspaceRail sections={NAV} activeId={chrome.activeId} user={USER} />}>
    <TopBar searchPlaceholder="Search clients, jobs and reports…" crumbs={crumbTrail(workspaceCrumbs(chrome.label, chrome.href))} />
    {card}
  </AppShell>;
}

/** Inside the shell the card is a region of AppShell's own <main>; standalone it is the page's <main>. */
function State({ kind, title, detail, reference, inShell }: { kind: StateKind; title: string; detail: string; reference?: string; inShell: boolean }) {
  const icon = kind === "loading" ? "↻" : kind === "empty" ? "＋" : "!";
  const content = <section><span className="nz-state-icon" aria-hidden="true">{icon}</span><div><span className="nz-eyebrow">{kind === "loading" ? "Retrieving data" : kind === "empty" ? "Ready for first record" : "Data unavailable"}</span><h1>{title}</h1><p>{detail}</p>{reference ? <small>Reference {reference}</small> : null}</div></section>;
  const props = { className: `nz-screen-state ${kind}`, role: kind === "failed" ? "alert" : "status", "aria-live": "polite" as const };
  return inShell ? <div {...props}>{content}</div> : <main {...props}>{content}</main>;
}

/**
 * A staff page's 404 — a record that does not exist in this organisation — inside the same chrome, with a way back.
 * Used by the segment `not-found` files of the client and job workspaces; the root keeps Next's default, because it
 * also answers portal, trainee and public paths, where a staff rail would be wrong.
 */
export function WorkspaceNotFound({ chrome, what }: { chrome: ScreenChrome; what: string }) {
  return <AppShell rail={<WorkspaceRail sections={NAV} activeId={chrome.activeId} user={USER} />}>
    <TopBar searchPlaceholder="Search clients, jobs and reports…" crumbs={crumbTrail(workspaceCrumbs(chrome.label, chrome.href))} />
    <div className="nz-screen-state failed" role="status" aria-live="polite"><section><span className="nz-state-icon" aria-hidden="true">?</span><div><span className="nz-eyebrow">Not found</span><h1>This {what} does not exist here</h1><p>It may have been removed, or it belongs to another organisation. <a href={chrome.href}>Back to {chrome.label}</a>.</p></div></section></div>
  </AppShell>;
}
