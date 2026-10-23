// The staff preview's pages for a client (BUILD-staff-portal-preview-job-aware): the portal's home, Reports index and job
// surfaces, mirrored under the client in the staff console — and nothing else. Pure, so server pages and tests share it.

export const portalPreviewBase = (clientId: string) => `/clients/${encodeURIComponent(clientId)}/portal-preview`;
export const portalPreviewApi = (clientId: string) => `/api/isolated/clients/${encodeURIComponent(clientId)}/portal-preview`;

/**
 * A portal path as the preview reaches it: `/portal` → the preview home, `/portal/reports` and `/portal/srs` → their preview
 * pages, `/portal/jobs/{id}` (and `/dashboard`, `/data`, `/actions`, with any query or fragment) → the job's preview page. Anything else — the account, intensity, a
 * download — has no preview counterpart, and is null, so the control is left out rather than sending a consultant into the portal.
 */
export function previewLink(clientId: string, path: string): string | null {
  const match = /^\/portal(\/reports|\/srs|\/jobs\/[^/?#]+(?:\/dashboard|\/data|\/actions|\/metrics)?)?\/?([?#].*)?$/.exec(path);
  if (!match) return null;
  return `${portalPreviewBase(clientId)}${match[1] ?? ""}${match[2] ?? ""}`;
}
