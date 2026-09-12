import type { Crumb } from "@nzi/ui";

/**
 * The one place the breadcrumb trail is built. Pure data — `crumbTrail` renders it.
 *
 * The live hierarchy is client-first: a job belongs to a client, so its trail reads
 * Clients / <Client> / Jobs / <Job No> / <Area>. Pages used to assemble this inline and
 * the job pages started at "Jobs", dropping the client entirely; building it here from
 * the job's own `clientId` makes that impossible rather than merely discouraged.
 *
 * Every crumb resolves to a real route, including the current page — it is marked with
 * `aria-current="page"`, not turned into text.
 */

/** The jobs list scoped to one client. */
export const clientJobsHref = (clientId: string) => `/jobs?client=${encodeURIComponent(clientId)}`;
const clientHref = (clientId: string) => `/clients/${encodeURIComponent(clientId)}`;
const jobHref = (jobId: string) => `/jobs/${encodeURIComponent(jobId)}`;

/** Clients / <Client name>. In-client areas live on the left sub-nav, not in the trail. */
export function clientCrumbs(client: { id: string; name: string }): Crumb[] {
  return [
    { label: "Clients", href: "/clients" },
    { label: client.name, href: clientHref(client.id), current: true },
  ];
}

/**
 * Clients / <Client> / Jobs / <Job No> — plus the area when the page is a job sub-area.
 * `area.href` defaults to the job's own route for areas that are not yet a route of
 * their own, so no crumb is ever a dead link.
 */
export function jobCrumbs(
  job: { id: string; number: string; clientId: string; client: string },
  area?: { label: string; href?: string },
): Crumb[] {
  const trail: Crumb[] = [
    { label: "Clients", href: "/clients" },
    { label: job.client, href: clientHref(job.clientId) },
    { label: "Jobs", href: clientJobsHref(job.clientId) },
    { label: job.number, href: jobHref(job.id), current: area === undefined },
  ];
  if (area) trail.push({ label: area.label, href: area.href ?? jobHref(job.id), current: true });
  return trail;
}

/** A workspace board that is its own destination — the crumb still links to itself. */
export function workspaceCrumbs(label: string, href: string, child?: { label: string; href: string }): Crumb[] {
  return child
    ? [{ label, href }, { label: child.label, href: child.href, current: true }]
    : [{ label, href, current: true }];
}
