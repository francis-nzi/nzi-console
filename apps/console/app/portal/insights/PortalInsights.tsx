"use client";
// Insights & Help (BUILD-portal-shell-lookandfeel, Support). Insights are real: observations from the job's assured figures
// (`insightsFrom`, the dashboard's own read), each cited to the report. Help is honest: the adviser is a message away (Messages);
// the mockup's grounded assistant is staff-side today and is marked as coming, never imitated.
import { useCallback, useEffect, useState } from "react";
import type { PortalAssuredDashboard } from "@nzi/contracts";
import { useOrganisationName } from "../../lib/OrganisationNameProvider";
import { usePortalSurface } from "../portalSurface";
import { isPortalAssuredDashboard } from "../jobs/[jobId]/portalAnalyticsValidation";
import { insightsFrom, type Insight } from "./insightsView";

type State = { kind: "loading" } | { kind: "failed" } | { kind: "empty" } | { kind: "ready"; year: number; insights: Insight[] };

export function PortalInsights({ jobId }: { jobId: string }) {
  const surface = usePortalSurface();
  const org = useOrganisationName();
  const [state, setState] = useState<State>({ kind: "loading" });
  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const response = await fetch(`${surface.api}/jobs/${encodeURIComponent(jobId)}/dashboard`, { cache: "no-store" });
      if (await surface.sessionEnded(response)) return;
      const body: unknown = response.ok ? await response.json() : null;
      if (!isPortalAssuredDashboard(body)) { setState({ kind: "failed" }); return; }
      const dashboard = body as PortalAssuredDashboard;
      setState(dashboard.published ? { kind: "ready", year: dashboard.reportingYear, insights: insightsFrom(dashboard) } : { kind: "empty" });
    } catch { setState({ kind: "failed" }); }
  }, [jobId, surface]);
  useEffect(() => { void load(); }, [load]);
  const messages = surface.link(`/portal/jobs/${encodeURIComponent(jobId)}/messages`);

  return (
    <div className="nzp-metrics">
      <header className="nz-pd-top">
        <div>
          <span className="nz-eyebrow">Support</span>
          <h1 className="nz-pd-client">Insights &amp; Help</h1>
          <p className="nz-pd-meta">What your assured figures say, and where to get help</p>
        </div>
      </header>

      <section className="nzp-metric-card" aria-labelledby="insights-title">
        <div className="nzp-metric-h"><h3 id="insights-title">Insights</h3></div>
        {state.kind === "loading" ? <p className="nzp-metric-note" role="status">Reading your assured report…</p>
          : state.kind === "failed" ? <p className="nzp-metric-note" role="alert">Your insights could not be loaded just now. Nothing has been assumed. <button className="nz-btn sm" onClick={() => void load()}>Try again</button></p>
          : state.kind === "empty" ? <p className="nzp-metric-note">Insights appear once your first assured report for this job is published.</p>
          : state.insights.length === 0 ? <p className="nzp-metric-note">Nothing stands out in this report yet.</p>
          : <>
              <ul className="nzp-insights">
                {state.insights.map((insight) => <li key={insight.id}><span className="ic" aria-hidden="true">💡</span><div><b>{insight.title}</b><p>{insight.detail}</p></div></li>)}
              </ul>
              <p className="nzp-metric-note">From your assured, published report for reporting year {state.year} — the same figures as your dashboard.</p>
            </>}
      </section>

      <section className="nzp-metric-card" aria-labelledby="help-title">
        <div className="nzp-metric-h"><h3 id="help-title">Help</h3></div>
        <ul className="nzp-insights">
          <li><span className="ic" aria-hidden="true">✉</span><div><b>Ask {org.your("adviser")}</b><p>Questions about your figures or your report go straight to {org.your("team")} in Messages.</p>
            {messages ? <a className="nz-btn sm" href={messages}>Open Messages</a> : null}</div></li>
          <li className="soon"><span className="ic" aria-hidden="true">?</span><div><b>Ask the assistant <span className="nzp-early">Coming soon</span></b><p>Grounded, cited answers from your data and {org.short}&rsquo;s knowledge library are on the way to the portal.</p></div></li>
        </ul>
      </section>
    </div>
  );
}
