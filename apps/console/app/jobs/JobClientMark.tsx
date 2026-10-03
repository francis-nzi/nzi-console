"use client";

import { LogoMark } from "../lib/LogoMark";

/**
 * The client's logo on a job header (CLIENT-02) — the stored copy, never a remote address — or its monogram when there is
 * none or it fails to load. One mark for every family's header (CRP, LCA/PCF, training and the rest).
 */
export function JobClientMark({ header }: { header: { clientId: string; client: string; clientLogoAssetId?: string | null } }) {
  const src = header.clientLogoAssetId ? `/api/isolated/clients/${encodeURIComponent(header.clientId)}/logo?v=${encodeURIComponent(header.clientLogoAssetId)}` : null;
  return <LogoMark src={src} name={header.client} className="nz-job-client-mark" />;
}
