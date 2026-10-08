"use client";

import { useEffect, useState } from "react";
import { GatedButton } from "@nzi/ui";
import { putBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import {
  activeMetrics, currencySymbol, intensityDenominatorText, intensityUnit, intensityUnitShort, resolveIntensity,
  type ClientIntensityTarget, type IntensityMetricDefinition, type IntensityMetricValue,
} from "@nzi/contracts";
import { useEditAccess } from "../lib/useEditAccess";
import { IntensityMetricIcon } from "../clients/[clientId]/IntensityMetricIcon";
import { intensityFigure, targetText } from "./intensityTargetText";

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
const figure = intensityFigure;

type AnnualMetricsPayload = {
  reportingYear: number;
  /** The job's client's currency — a currency metric reads in it (D3c). */
  currency: string;
  assuredTotalTco2e: number | null;
  metrics: IntensityMetricDefinition[];
  values: IntensityMetricValue[];
  resolved: Record<string, { value: number | null; reason?: string }>;
  /** Phase 3c: the client's targets in force, and the metric the CRP reports (null when none). */
  targets?: ClientIntensityTarget[];
  reportedMetricKey?: string | null;
};

export function JobAnnualMetrics({ jobId, reportingYear, writeEnabled, clientId }: {
  jobId: string;
  reportingYear: number;
  writeEnabled: boolean;
  /** For the link to the client, where metrics are ordered and targets set (Phase 3c). */
  clientId?: string;
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
      : <div style={{ overflowX: "auto" }}><table className="nz-tbl nz-metric-table">
        <thead><tr><th>Metric</th><th>Source</th><th>Value this year</th><th>Divider</th><th className="num">Intensity</th><th>Client target</th></tr></thead>
        <tbody>
          {active.map((metric) => <MetricValueRow key={metric.key} jobId={jobId} reportingYear={reportingYear} metric={metric} currency={payload?.currency ?? "GBP"}
            target={payload?.targets?.find((entry) => entry.metricKey === metric.key) ?? null}
            reported={payload?.reportedMetricKey === metric.key}
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
            <td colSpan={4} className="muted" style={{ textAlign: "right" }}>Coming with system-wide time — recordable through the job here</td>
          </tr>
        </tbody>
      </table></div>}

    <div className="nz-card-b">
      {/* Phase 3c (ruled): which metric the CRP reports, and how it is chosen. */}
      <p className="nz-hint nz-reported-note" role="note">
        {payload?.reportedMetricKey
          ? <>The CRP reports <b>{active.find((metric) => metric.key === payload.reportedMetricKey)?.label ?? payload.reportedMetricKey}</b> — the first standard metric (turnover, employees, floor area) with a target, in the client&apos;s metric order. Reorder the metrics on the client to report another.</>
          : <>No intensity is reported in the CRP: no standard metric (turnover, employees, floor area) has a client target. A target on a custom metric is shown here but is not reported in this version.</>}
        {clientId ? <> <a className="nz-editlink" href={`/clients/${encodeURIComponent(clientId)}#client-intensity-targets`}>Targets and metric order on the client</a></> : null}
      </p>
      <p className="nz-maps">Metrics are defined on the client (Carbon Analytics → Manage metrics). This job records the annual values; intensity = assured emissions × divider ÷ value. Adding a metric happens on the client, not here.</p>
      <div className="nz-gov"><span className="lk" aria-hidden="true">🔒</span><span>Values are captured <b>per reporting year</b> and versioned; each writes an audit event. A site-derived metric resolves from the client&apos;s in-service sites for this year — override it if this job needs a different basis. These figures feed the client year-on-year, the portal and the report.</span></div>
    </div>
  </section>;
}

function MetricValueRow({ jobId, reportingYear, metric, currency, assuredTotalTco2e, recorded, resolved, access, onSaved, onError, target, reported }: {
  jobId: string;
  target: ClientIntensityTarget | null;
  reported: boolean;
  currency: string;
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
  const intensity = resolveIntensity({ definition: metric, emissionsTco2e: assuredTotalTco2e, value: effective ?? null, currency });
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
      {siteDerived ? <span className="nz-tag" style={{ marginLeft: 6 }}>From sites</span> : null}
      {reported ? <span className="nz-st done" style={{ marginLeft: 6 }}>Reported in the CRP</span> : null}</td>
    <td>{siteDerived
      ? <>Auto · in-service sites{" "}
        <button type="button" className="nz-editlink" onClick={() => setOverriding(!overriding)}>{overriding ? "use resolved" : "override"}</button></>
      : "Entered"}</td>
    <td>{siteDerived && !overriding
      ? <span className="nz-auto-val">{resolved.value === null
        ? <span className="muted" title={resolved.reason}>Unavailable</span>
        : intensityDenominatorText(metric, resolved.value, { currency })}</span>
      : <input className="nz-inp num" inputMode="decimal" value={draft} onChange={(event) => setDraft(event.target.value)}
        aria-label={`${metric.label} value for ${reportingYear}`}
        // A currency value is whole units: "12.5" meaning £12.5m is the error 0143 had to correct (D3, Q6).
        placeholder={metric.unitKind === "currency" ? `Whole ${currencySymbol(currency)}, not ${currencySymbol(currency)}m` : "Not recorded"} />}</td>
    <td className="muted">{intensityUnit(metric, { currency })}</td>
    <td className="num">{intensity.state === "resolved"
      ? <><b>{figure(intensity.value)}</b> <small className="muted">{intensityUnitShort(metric, { currency })}</small></>
      : <span className="muted" title={intensity.reason}>Unavailable</span>}
      {dirty ? <GatedButton className="nz-editlink" blocked={pending || access.state !== "allowed"}
        blockedReason={pending ? "Saving…" : access.state === "allowed" ? undefined : access.reason}
        reasonClassName="hint nz-gated-reason" onClick={() => void save()}>Save</GatedButton> : null}
    </td>
    <td className={target ? "" : "muted"} style={{ minWidth: 200 }}>{target ? targetText(target) : "No target"}</td>
  </tr>;
}
