"use client";
// Where a client portal component reads from and links to (BUILD-staff-portal-preview-job-aware, R2/R5). The client's own
// components — the Data view, the Dashboard, the Reports index, the report workspace — are drawn in two places: the portal, for a
// signed-in client, and the staff preview, for a consultant before any client is invited. They are the same components reading
// the same assembly; only this differs:
//  - `api`: the client's routes (`/api/portal`), or the staff preview's mirror of them (`/api/isolated/clients/{id}/portal-preview`);
//  - `link`: a portal page as this surface reaches it — or null, where it has no counterpart, and the control is left out;
//  - `readOnly`: the preview draws no entry, no approval, no deactivation — nothing that would POST (R5);
//  - `sessionEnded`: a client whose portal session ended is sent to sign in again; a preview has no portal session to end.
// The portal is the default, so a component outside any provider is the client's, exactly as before.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { redirectIfPortalSessionEnded } from "./portalSessionClient";
import { portalPreviewApi, previewLink } from "./portalPreviewLinks";

export type PortalSurface = {
  api: string;
  link: (path: string) => string | null;
  readOnly: boolean;
  sessionEnded: (response: Response) => Promise<boolean>;
};

export const CLIENT_PORTAL_SURFACE: PortalSurface = { api: "/api/portal", link: (path) => path, readOnly: false, sessionEnded: redirectIfPortalSessionEnded };

export function previewSurface(clientId: string): PortalSurface {
  return {
    api: portalPreviewApi(clientId),
    link: (path) => previewLink(clientId, path),
    readOnly: true,
    sessionEnded: async () => false,
  };
}

const SurfaceContext = createContext<PortalSurface>(CLIENT_PORTAL_SURFACE);

export const usePortalSurface = () => useContext(SurfaceContext);

/** The staff preview's surface for one client, around the client's own components. */
export function PreviewSurfaceProvider({ clientId, children }: { clientId: string; children: ReactNode }) {
  const surface = useMemo(() => previewSurface(clientId), [clientId]);
  return <SurfaceContext.Provider value={surface}>{children}</SurfaceContext.Provider>;
}
