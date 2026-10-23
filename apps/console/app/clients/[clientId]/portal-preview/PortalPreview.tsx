"use client";

import Link from "next/link";
import type { PortalPreviewJob, PortalPreviewReadModel } from "@nzi/isolated-backend";
import { portalFeatureEnabled } from "../../../lib/portalFlags";
import { PortalReadiness } from "../../../portal/PortalReadiness";
import { PortalReductionPlan } from "../../../portal/PortalReductionPlan";
import { portalPreviewBase } from "../../../portal/portalPreviewLinks";
import { portalProfileDifferences } from "@nzi/contracts";

/**
 * The staff preview of a client's portal — its home.
 *
 * Renders the client's own components with the client's own read models. There is no second
 * implementation of the plan or the readiness statement here, and that is the point: the preview
 * is only trustworthy while "what the consultant sees" and "what the client sees" are the same
 * code reading the same resolvers.
 *
 * The flag gates are applied here exactly as `PortalHome` applies them, so a surface the client
 * cannot currently see is a surface the preview does not show either. Without that, a consultant
 * could walk a client through a page that is switched off for them.
 *
 * Job-aware (R3): the client's own jobs — not its portal grants — each opening into the client's job surfaces, so a client
 * nobody has been invited for yet previews in full.
 */
export function PortalPreview({ preview }: { preview: PortalPreviewReadModel }) {
  const plan = portalFeatureEnabled("portal-plan");
  const readiness = portalFeatureEnabled("portal-readiness");

  return (
    <div className="nz-portal-shell">
      <p className="nz-maps">
        This is {preview.client.name}&rsquo;s portal as they see it — the same figures, the same
        plan, the same readiness statement, resolved live.
        {!plan || !readiness
          ? " Surfaces switched off for clients are hidden here too, so what is missing below is missing for them."
          : null}
      </p>

      {/* Portal data-entry phase 1: why this client's portal may differ from the default — the decisions themselves, from
          the resolver Portal Management reads. Staff-only and labelled so: it is the explanation, not part of the view. */}
      <ProfileDifferences preview={preview} />

      <PreviewJobs preview={preview} />

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
  );
}

/** R3: every job of the client's, from the client's jobs — whoever, if anyone, has been granted it. */
function PreviewJobs({ preview }: { preview: PortalPreviewReadModel }) {
  const base = portalPreviewBase(preview.client.id);
  const analytics = portalFeatureEnabled("portal-analytics"), data = portalFeatureEnabled("portal-data");
  const href = (job: PortalPreviewJob, surface = "") => `${base}/jobs/${encodeURIComponent(job.id)}${surface}`;
  return (
    <section className="nz-panel nz-preview-jobs" aria-labelledby="preview-jobs-title">
      <div className="nz-preview-jobs-h">
        <h2 id="preview-jobs-title">Reporting jobs</h2>
        <p className="muted">Staff only — every job of {preview.client.name}&rsquo;s, whether or not a portal user has been granted it. Open one to see it as the client would.</p>
      </div>
      {preview.jobs.length === 0 ? <p className="muted" role="status">This client has no jobs yet, so there is nothing job-level to preview.</p> : (
        <table className="nz-tbl">
          <thead><tr><th>Job</th><th>Title</th><th>Year</th><th>Published report</th><th>Preview</th></tr></thead>
          <tbody>
            {preview.jobs.map((job) => (
              <tr key={job.id}>
                <td><b>{job.number}</b> <span className="nz-preview-family">{job.family.toUpperCase()}</span></td>
                <td>{job.title}</td>
                <td>{job.reportingYear ?? "—"}</td>
                <td>{job.hasPublishedReport ? job.publishedReports.length > 1 ? `${job.publishedReports.length} scopes` : "Yes" : "Not yet"}</td>
                <td className="nz-preview-links">
                  {analytics ? <Link href={href(job, "/dashboard")}>Dashboard</Link> : null}
                  {data ? <Link href={href(job, "/data")}>Data</Link> : null}
                  <Link href={href(job)}>Report</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function ProfileDifferences({ preview }: { preview: PortalPreviewReadModel }) {
  const differences = portalProfileDifferences(preview.profile);
  return (
    <aside className="nz-preview-profile" aria-label="How this client's portal differs from the default">
      <b>Staff only — this client&rsquo;s portal profile.</b>{" "}
      {differences.length === 0
        ? "It is your organisation's default: nothing has been decided differently for this client."
        : <>It differs from your organisation&rsquo;s default where somebody decided so:
          <ul>{differences.map((line) => <li key={line}>{line}</li>)}</ul></>}
      {" "}Who decided each, when and why is in Portal Management. {portalFeatureEnabled("portal-data") ? "These settings are in force in the portal." : "Category visibility applies in the portal now; the other settings take effect with the next phase of portal data entry."}
    </aside>
  );
}
