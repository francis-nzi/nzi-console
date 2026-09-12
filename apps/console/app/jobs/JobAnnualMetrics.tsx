"use client";

import { useEffect, useState } from "react";
import { GatedButton } from "@nzi/ui";
import { putBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import {
  activeMetrics, intensityUnit, intensityUnitShort, resolveIntensity,
  type IntensityMetricDefinition, type IntensityMetricValue,
} from "@nzi/contracts";
import { useEditAccess } from "../lib/useEditAccess";
import { IntensityMetricIcon } from "../clients/[clientId]/IntensityMetricIcon";

/**
 * Annual metrics — the JOB side of the intensity workflow (`job_annual_metrics_v1`).
 *
 * The client defines the metric set; this records the annual value for each one, per
 * reporting year. Intensity is shown as it is computed — emissions × divider ÷ value — so
 * the person typing the denominator sees immediately what it produces.
 *
 * A site-derived metric resolves its own value from the client's in-service sites for the
 * year and is shown read-only until someone deliberately overrides it.
 */

const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;
const figure = (value: number) => value >= 100 ? Math.round(value).toLocaleString("en-GB") : value.toLocaleString("en-GB", { maximumFractionDigits: 2 });

type AnnualMetricsPayload = {
  reportingYear: number;
  assuredTotalTco2e: number | null;
  metrics: IntensityMetricDefinition[];
  values: IntensityMetricValue[];
  resolved: Record<string, { value: number | null; reason?: string }>;
};

export function JobAnnualMetrics({ jobId, reportingYear, writeEnabled }: {
  jobId: string;
  reportingYear: number;
  writeEnabled: boolean;
}) {
  const access = useEditAccess("scoperow.edit", writeEnabled);
  const [payload, setPayload] = useState<AnnualMetricsPayload | null>(null);
  const [values, setValues] = useState<IntensityMetricValue[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = activeMetrics(payload?.metrics ?? []);
  const assuredTotalTco2e = payload?.assuredTotalTco2e ?? null;
  const resolvedValues = payload?.resolved ?? {};

  useEffect(() => {
    let live = true;
    setState("loading");
    fetch(`/api/isolated/jobs/${encodeURIComponent(jobId)}/intensity-values?year=${reportingYear}`, { headers: { accept: "application/json" } })
      .then((response) => response.ok ? response.json() as Promise<AnnualMetricsPayload> : Promise.reject(new Error(String(response.status))))
      .then((body) => { if (live) { setPayload(body); setValues(body.values); setState("ready"); } })
      .catch(() => { if (live) setState("failed"); });
    return () => { live = false; };
  }, [jobId, reportingYear]);

  if (state === "loading") return <section className="nz-panel"><div className="nz-card-b"><p className="sub">Reading this year&apos;s annual metrics…</p></div></section>;
  if (state === "failed") return <section className="nz-panel"><div className="nz-card-b"><p className="sub">The annual metrics could not be read. Nothing is shown rather than a figure that might be wrong.</p></div></section>;

  return <section className="nz-panel">
    <div className="nz-card-h"><span className="nz-eyebrow">Carbon</span><h2>Annual metrics</h2><span className="sp" />
      <span className="hint">reporting year {reportingYear}</span></div>

    <div className="nz-basis-strip">
      <span>Assured emissions this year</span>
      <b>{assuredTotalTco2e === null ? "Not yet issued" : `${Math.round(assuredTotalTco2e).toLocaleString("en-GB")} tCO₂e`}</b>
      <span className="hint">{assuredTotalTco2e === null
        ? "— intensity appears once this year has a reviewed snapshot"
        : "— the numerator for every intensity below"}</span>
      <span className="sp" />
      <span className="hint">resolved from the reviewed snapshot</span>
    </div>

    {notice ? <div className="nz-banner ok" role="status">{notice}</div> : null}
    {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}

    {active.length === 0
      ? <div className="nz-card-b"><p className="sub">This client has no intensity metrics defined. Add them on the client — Carbon Analytics → Manage metrics — and they appear here.</p></div>
      : <table className="nz-tbl nz-metric-table">
        <thead><tr><th>Metric</th><th>Source</th><th>Value this year</th><th>Divider</th><th className="num">Intensity</th></tr></thead>
        <tbody>
          {active.map((metric) => <MetricValueRow key={metric.key} jobId={jobId} reportingYear={reportingYear} metric={metric}
            assuredTotalTco2e={assuredTotalTco2e}
            recorded={values.find((value) => value.metricKey === metric.key && value.periodKey === "year") ?? null}
            resolved={resolvedValues[metric.key] ?? { value: null }}
            access={access}
            onSaved={(next, text) => {
              setValues((current) => [...current.filter((value) => !(value.metricKey === next.metricKey && value.periodKey === next.periodKey)), next]);
              setNotice(text); setError(null);
            }}
            onError={setError} />)}
          {/* The seam Francis flagged: time is coming, and it arrives through the job. */}
          <tr className="nz-time-row">
            <td><IntensityMetricIcon iconKey="metric" size={14} style={{ marginRight: 6, verticalAlign: "-2px" }} />Time recorded on this job</td>
            <td className="muted">—</td>
            <td colSpan={3} className="muted" style={{ textAlign: "right" }}>Coming with system-wide time — recordable through the job here</td>
          </tr>
        </tbody>
      </table>}

    <div className="nz-card-b">
      <p className="nz-maps">Metrics are defined on the client (Carbon Analytics → Manage metrics). This job records the annual values; intensity = assured emissions × divider ÷ value. Adding a metric happens on the client, not here.</p>
      <div className="nz-gov"><span className="lk" aria-hidden="true">🔒</span><span>Values are captured <b>per reporting year</b> and versioned; each writes an audit event. A site-derived metric resolves from the client&apos;s in-service sites for this year — override it if this job needs a different basis. These figures feed the client year-on-year, the portal and the report.</span></div>
    </div>
  </section>;
}

function MetricValueRow({ jobId, reportingYear, metric, assuredTotalTco2e, recorded, resolved, access, onSaved, onError }: {
  jobId: string;
  reportingYear: number;
  metric: IntensityMetricDefinition;
  assuredTotalTco2e: number | null;
  recorded: IntensityMetricValue | null;
  resolved: { value: number | null; reason?: string };
  access: ReturnType<typeof useEditAccess>;
  onSaved: (value: IntensityMetricValue, text: string) => void;
  onError: (text: string) => void;
}) {
  const siteDerived = metric.valueSource === "site-floor-area";
  const [draft, setDraft] = useState(recorded?.value === null || recorded === null ? "" : String(recorded.value));
  const [overriding, setOverriding] = useState(recorded?.value != null && siteDerived);
  const [pending, setPending] = useState(false);

  const typed = draft.trim() === "" ? null : Number(draft);
  const effective = siteDerived && !overriding ? resolved.value : typed;
  const intensity = resolveIntensity({ definition: metric, emissionsTco2e: assuredTotalTco2e, value: effective ?? null });
  const dirty = (recorded?.value ?? null) !== (siteDerived && !overriding ? null : typed);

  async function save() {
    setPending(true);
    const result = await putBrowserCommand<{ version: number }>(
      `/api/isolated/jobs/${encodeURIComponent(jobId)}/intensity-values`,
      { reportingYear, metricKey: metric.key, value: siteDerived && !overriding ? null : typed, periodKey: "year", expectedVersion: recorded?.version ?? 0 },
      crypto.randomUUID());
    setPending(false);
    if (result.state !== "success") { onError(errorText(result)); return; }
    onSaved({
      metricKey: metric.key, reportingYear, periodKey: "year",
      value: siteDerived && !overriding ? null : typed, overridesResolved: siteDerived && overriding,
      note: "", version: result.data.version,
    }, `${metric.label} saved for ${reportingYear}.`);
  }

  return <tr>
    <td><IntensityMetricIcon iconKey={metric.iconKey} size={14} style={{ marginRight: 6, verticalAlign: "-2px" }} />{metric.label}
      {metric.isStandard ? <span className="nz-tag rr" style={{ marginLeft: 6 }}>Standard</span> : null}
      {siteDerived ? <span className="nz-tag" style={{ marginLeft: 6 }}>From sites</span> : null}</td>
    <td>{siteDerived
      ? <>Auto · in-service sites{" "}
        <button type="button" className="nz-editlink" onClick={() => setOverriding(!overriding)}>{overriding ? "use resolved" : "override"}</button></>
      : "Entered"}</td>
    <td>{siteDerived && !overriding
      ? <span className="nz-auto-val">{resolved.value === null
        ? <span className="muted" title={resolved.reason}>Unavailable</span>
        : `${resolved.value.toLocaleString("en-GB")} ${metric.unitWording}`}</span>
      : <input className="nz-inp num" inputMode="decimal" value={draft} onChange={(event) => setDraft(event.target.value)}
        aria-label={`${metric.label} value for ${reportingYear}`} placeholder="Not recorded" />}</td>
    <td className="muted">{intensityUnit(metric)}</td>
    <td className="num">{intensity.state === "resolved"
      ? <><b>{figure(intensity.value)}</b> <small className="muted">{intensityUnitShort(metric)}</small></>
      : <span className="muted" title={intensity.reason}>Unavailable</span>}
      {dirty ? <GatedButton className="nz-editlink" blocked={pending || access.state !== "allowed"}
        blockedReason={pending ? "Saving…" : access.state === "allowed" ? undefined : access.reason}
        reasonClassName="hint nz-gated-reason" onClick={() => void save()}>Save</GatedButton> : null}
    </td>
  </tr>;
}
