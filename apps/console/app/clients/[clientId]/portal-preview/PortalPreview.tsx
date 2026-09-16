"use client";

import Link from "next/link";
import type { PortalPreviewReadModel } from "@nzi/isolated-backend";
import { portalFeatureEnabled } from "../../../lib/portalFlags";
import { PortalReadiness } from "../../../portal/PortalReadiness";
import { PortalReductionPlan } from "../../../portal/PortalReductionPlan";

/**
 * The staff preview of a client's portal.
 *
 * Renders the client's own components with the client's own read models. There is no second
 * implementation of the plan or the readiness statement here, and that is the point: the preview
 * is only trustworthy while "what the consultant sees" and "what the client sees" are the same
 * code reading the same resolvers.
 *
 * The flag gates are applied here exactly as `PortalHome` applies them, so a surface the client
 * cannot currently see is a surface the preview does not show either. Without that, a consultant
 * could walk a client through a page that is switched off for them.
 */
export function PortalPreview({ preview }: { preview: PortalPreviewReadModel }) {
  const plan = portalFeatureEnabled("portal-plan");
  const readiness = portalFeatureEnabled("portal-readiness");

  return (
    <div className="nz-portal-preview">
      {/* Persistent, not dismissible, and first in the document so it is also the first thing a
          screen reader reaches. A preview that can be mistaken for the live client view is the
          one failure mode this banner exists to prevent. */}
      <div className="nz-preview-bar" role="status">
        <span className="nz-preview-tag">Staff preview</span>
        <b>{preview.client.name}</b>
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

      <div className="nz-portal-shell">
        <p className="nz-maps">
          This is {preview.client.name}&rsquo;s portal as they see it — the same figures, the same
          plan, the same readiness statement, resolved live.
          {!plan || !readiness
            ? " Surfaces switched off for clients are hidden here too, so what is missing below is missing for them."
            : null}
        </p>

        {plan ? <PortalReductionPlan model={preview.strategies} /> : null}
        {readiness ? <PortalReadiness model={preview.readiness} /> : null}

        {!plan && !readiness ? (
          <section className="nz-panel">
            <div className="nz-portal-state" role="status">
              <b>Both portal surfaces are switched off</b>
              <span>
                Neither the reduction plan nor the readiness statement is enabled for clients in
                this build, so this client&rsquo;s portal has neither. That is their real
                experience, not a fault in the preview.
              </span>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
