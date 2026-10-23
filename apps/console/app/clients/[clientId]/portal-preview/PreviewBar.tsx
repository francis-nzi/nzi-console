import Link from "next/link";
import type { PortalPreviewReadModel, PortalPreviewSurface } from "@nzi/isolated-backend";
import { portalFeatureEnabled } from "../../../lib/portalFlags";
import { portalPreviewBase } from "../../../portal/portalPreviewLinks";

/**
 * The staff preview's banner, on every previewed surface — persistent, not dismissible, and first in the document so it is also
 * the first thing a screen reader reaches. A preview that can be mistaken for the live client view is the one failure mode this
 * banner exists to prevent. Under it, the client's surfaces as the client's portal offers them: a surface switched off for
 * clients is not offered here either.
 */
export function PreviewBar({ preview, surface }: { preview: PortalPreviewReadModel; surface: PortalPreviewSurface }) {
  const base = portalPreviewBase(preview.client.id);
  const job = preview.job;
  const jobBase = job ? `${base}/jobs/${encodeURIComponent(job.id)}` : null;
  const items: Array<{ key: PortalPreviewSurface; label: string; href: string }> = [
    { key: "home", label: "Portal home", href: base },
    ...(portalFeatureEnabled("portal-reports") ? [{ key: "reports" as const, label: "Reports", href: `${base}/reports` }] : []),
    ...(jobBase ? [
      ...(portalFeatureEnabled("portal-analytics") ? [{ key: "dashboard" as const, label: "Dashboard", href: `${jobBase}/dashboard` }] : []),
      ...(portalFeatureEnabled("portal-data") ? [{ key: "data" as const, label: "Data", href: `${jobBase}/data` }] : []),
      { key: "report" as const, label: "Report", href: jobBase },
    ] : []),
  ];
  return (
    <>
      <div className="nz-preview-bar" role="status">
        <span className="nz-preview-tag">Staff preview</span>
        <b>{preview.client.name}</b>
        {job ? <span className="nz-preview-job">{job.number} · {job.title}</span> : null}
        <span className="nz-preview-ro">read-only</span>
        <span className="sp" />
        <span className="hint">
          You are signed in as yourself. Nothing here is recorded as the client, and nothing can be
          changed from this page.
        </span>
        <Link className="nz-btn sm" href={`/clients/${encodeURIComponent(preview.client.id)}`}>
          Back to the client
        </Link>
      </div>
      <nav className="nz-preview-nav" aria-label="Client portal surfaces">
        {items.map((item) => (
          <Link key={item.key} href={item.href} className={item.key === surface ? "on" : undefined} aria-current={item.key === surface ? "page" : undefined}>
            {item.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
