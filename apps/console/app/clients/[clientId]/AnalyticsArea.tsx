"use client";

import { useState } from "react";
import { CRP_RESOLVER_VERSION, EmissionsScopeDonut, IntensityBasesIndexed, IntensityPathway, RENDERER_VERSION, ScopeYearOnYearBar, TOKENS_VERSION } from "@nzi/charts";
import {
  activeMetrics, indexedSeries, intensityUnit, intensityUnitShort, resolveIntensity,
  type IntensityMetricDefinition, type ResolvedIntensity,
} from "@nzi/contracts";
import type { ClientWorkspaceReadModel, ClientYearFigure } from "@nzi/isolated-backend";
import type { EditAccess } from "../../lib/useEditAccess";
import { GatedButton } from "@nzi/ui";
import { ClientPathway } from "./ClientPathway";
import { CardHead, Empty } from "./OverviewArea";
import { IntensityMetricIcon } from "./IntensityMetricIcon";
import { EvidenceButton, TierBadge, fyLabel, tonnes } from "./FigureEvidence";
import type { DrawerRequest } from "./clientDrawers";

/**
 * Carbon Analytics (client workspace v11). Every series is resolved from the client's own
 * assured years, and intensity is measured against the metrics **this client defined** —
 * not a fixed set of bases. A metric with no value recorded for a year says so; none is
 * inferred from another metric or another year.
 */

type ChartProvenance = {
  jobId: string; dataHash: string; factorSets: string[]; generatedAt: string; reviewedSnapshotId: string;
  resolverVersion: number; tokensVersion: number; rendererVersion: number;
};
const ALL = "__all__";
const figure = (value: number) => value >= 100 ? Math.round(value).toLocaleString("en-GB") : value.toLocaleString("en-GB", { maximumFractionDigits: 2 });

/** One year's intensity on one metric, resolved through the shared computation. */
function intensityFor(year: ClientYearFigure, definition: IntensityMetricDefinition): ResolvedIntensity {
  const denominator = year.denominators[definition.key];
  const resolved = resolveIntensity({
    definition, emissionsTco2e: year.totalTco2e, value: denominator?.value ?? null,
    source: denominator?.source === "none" ? undefined : denominator?.source,
  });
  // Keep the resolver's reason unless the denominator itself explained why it is missing.
  if (resolved.state === "unavailable" && denominator?.reason) return { ...resolved, reason: denominator.reason };
  return resolved;
}

export function AnalyticsArea({ workspace, onEvidence, access, onDrawer }: {
  workspace: ClientWorkspaceReadModel;
  onEvidence: (key: "latest" | "scopes" | "intensity" | "yoy") => void;
  access: EditAccess;
  onDrawer: (request: DrawerRequest) => void;
}) {
  const { client, history, targets, actuals, intensityMetrics } = workspace;
  const years = [...history].sort((a, b) => a.year - b.year);
  const metrics = activeMetrics(intensityMetrics);
  const [pickedYear, setPickedYear] = useState<number | null>(null);
  const [metricKey, setMetricKey] = useState<string>(metrics[0]?.key ?? ALL);
  const selected = history.find((year) => year.year === pickedYear) ?? history[0] ?? null;

  if (history.length === 0) {
    return <section className="nz-panel">
      <CardHead eyebrow="Carbon" title="Carbon analytics" />
      <Empty text="No reviewed snapshot has been issued for this client, so there is nothing to analyse yet. Figures appear here once a CRP job issues its first assured year." />
    </section>;
  }

  const provenance = (snapshotId: string, jobId: string): ChartProvenance => ({
    jobId, dataHash: "", factorSets: [], generatedAt: "", reviewedSnapshotId: snapshotId,
    resolverVersion: CRP_RESOLVER_VERSION, tokensVersion: TOKENS_VERSION, rendererVersion: RENDERER_VERSION,
  });
  const manage = <GatedButton className="nz-editlink" blocked={access.state !== "allowed"}
    blockedReason={access.state === "allowed" ? undefined : access.reason} reasonClassName="hint nz-gated-reason"
    onClick={() => onDrawer({ kind: "intensity-metrics" })}>⚙ Manage metrics</GatedButton>;

  return <>
    <div className="nz-cw-vhead"><div><div className="eyebrow">Carbon</div><h2>Carbon analytics</h2></div><span style={{ flex: 1 }} />
      <label className="nz-fl nz-cw-yearpick"><span>Reporting year</span>
        <select className="nz-sel" value={selected?.year ?? ""} onChange={(event) => setPickedYear(Number(event.target.value))} aria-label="Reporting year">
          {history.map((year) => <option key={year.snapshotId} value={year.year}>{fyLabel(year.year)} · {year.jobNumber}</option>)}
        </select>
      </label>
    </div>
    <p className="nz-cw-vsub">Emissions history, scope split, reduction pathway and intensity — every figure resolved from this client&apos;s reviewed snapshots, with its provenance one click away.</p>

    <div className="nz-cw-grid">
      <div className="nz-cw-col">
        <section className="nz-panel">
          <CardHead eyebrow="Year on year" title="Emissions by scope" right={<EvidenceButton label="Year on year" onOpen={() => onEvidence("yoy")} />} />
          {years.length < 2
            ? <Empty text="One assured year so far — a year-on-year comparison needs two." />
            : <ScopeYearOnYearBar showChrome={false} data={{
              spec: { id: `client-yoy-${client.id}`, type: "scope_year_on_year_bar", title: "Annual emissions by scope", family: "crp", specVersion: 1 },
              unit: "tCO₂e", state: "success",
              years: years.map((year) => ({ year: year.year, values: year.scopes.map((scope) => ({ scope: scope.scope, value: scope.tco2e ?? 0 })) })),
              provenance: provenance(years[years.length - 1]!.snapshotId, years[years.length - 1]!.jobId),
            }} />}
        </section>

        <IntensityChart years={years} metrics={metrics} metricKey={metricKey} onMetric={setMetricKey}
          clientId={client.id} provenance={provenance} manage={manage} />

        <ClientPathway client={{ id: client.id, name: client.name }} targets={targets} actuals={actuals ?? []} />
      </div>

      <div className="nz-cw-col">
        <section className="nz-panel">
          <CardHead eyebrow={selected ? fyLabel(selected.year) : "Latest"} title="Scope split" right={<EvidenceButton label="Scope split" onOpen={() => onEvidence("scopes")} />} />
          {selected && selected.totalTco2e !== null && selected.totalTco2e > 0
            ? <div className="nz-donut-ring"><EmissionsScopeDonut ring showChrome={false} data={{
              spec: { id: `client-scope-split-${selected.snapshotId}`, type: "emissions_scope_donut", title: `${fyLabel(selected.year)} emissions by scope`, family: "crp", specVersion: 2 },
              unit: "tCO₂e", state: "success",
              segments: selected.scopes.map((scope) => ({ scope: scope.scope, label: `Scope ${scope.scope}`, value: scope.tco2e ?? 0 })),
              provenance: provenance(selected.snapshotId, selected.jobId),
            }} /></div>
            : null}
          <div className="nz-card-b">
            {selected?.scopes.map((scope) => <div className="nz-cw-kv" key={scope.scope}>
              <span className="k"><span className={`nz-scope-sw s${scope.scope}`} aria-hidden="true" />Scope {scope.scope}</span>
              <span className="v">{scope.tco2e === null ? "—" : `${Math.round(scope.tco2e).toLocaleString("en-GB")} · ${share(scope.tco2e, selected.totalTco2e)}`}<TierBadge tier={scope.qualityTier} /></span>
            </div>)}
            <div className="nz-cw-kv"><span className="k"><b>Total</b></span><span className="v"><b>{selected?.totalTco2e == null ? "—" : tonnes(selected.totalTco2e)}</b></span></div>
            {selected && !selected.provenance ? <p className="nz-maps">This year&apos;s snapshot carries no factor-set stamp, so its signature cannot be shown. The figures are unaffected.</p> : null}
          </div>
        </section>

        <IntensityDetail year={selected} years={years} metrics={metrics} metricKey={metricKey}
          onEvidence={() => onEvidence("intensity")} manage={manage} />
      </div>
    </div>
  </>;
}

function IntensityChart({ years, metrics, metricKey, onMetric, clientId, provenance, manage }: {
  years: ClientYearFigure[];
  metrics: IntensityMetricDefinition[];
  metricKey: string;
  onMetric: (key: string) => void;
  clientId: string;
  provenance: (snapshotId: string, jobId: string) => ChartProvenance;
  manage: React.ReactNode;
}) {
  const definition = metrics.find((metric) => metric.key === metricKey) ?? null;
  const picker = <>
    {manage}
    <select className="nz-sel" value={metricKey} onChange={(event) => onMetric(event.target.value)} aria-label="Intensity metric" style={{ marginRight: 8 }}>
      {metrics.map((metric) => <option key={metric.key} value={metric.key}>per {metric.unitWording}</option>)}
      {metrics.length > 1 ? <option value={ALL}>All metrics (indexed)</option> : null}
    </select>
    <span className="hint">{definition ? intensityUnit(definition) : "indexed · base = 100"}</span>
  </>;
  const head = <CardHead eyebrow="Year on year" title="Emissions intensity" right={picker} />;

  if (metrics.length === 0) {
    return <section className="nz-panel">{head}
      <Empty text="No intensity metric is defined for this client yet. Employees and Turnover are standard — add them, or any measure this client uses, with Manage metrics." />
    </section>;
  }

  if (metricKey === ALL) {
    const series = metrics.map((metric) => {
      const points = indexedSeries(years.map((year) => ({ year: year.year, intensity: intensityFor(year, metric) })));
      return points === null ? null : { key: metric.key, label: metric.label, points };
    }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const commonBase = years.map((year) => year.year).find((year) => series.every((entry) => entry.points.some((point) => point.year === year))) ?? null;

    return <section className="nz-panel">{head}
      {series.length === 0
        ? <Empty text="No metric resolves for two or more years yet, so there is nothing to index. Each metric needs its value recorded on at least two reporting years." />
        : <>
          <IntensityBasesIndexed showChrome={false} data={{
            spec: { id: `client-intensity-metrics-${clientId}`, type: "intensity_bases_indexed", title: "Emissions intensity — all metrics, indexed", family: "crp", specVersion: 1 },
            unit: "index", state: "success", baseYear: commonBase,
            series: series.map((entry, index) => ({
              // The chart carries three series slots; beyond that they share, which is why
              // the legend and the direct labels do the identifying rather than colour.
              key: (["turnover", "employee", "floor-area"] as const)[index % 3]!,
              label: entry.label, points: entry.points,
            })),
            provenance: provenance(years[years.length - 1]!.snapshotId, years[years.length - 1]!.jobId),
          }} />
          <div className="nz-card-b"><p className="nz-maps">Each metric has its own denominator and unit, so they share an axis only as an index{commonBase === null
            ? " — and because no single year resolves on every metric here, each is indexed to its own first year, so compare the shapes rather than the levels"
            : ` (${commonBase} = 100)`}. A metric is plotted only where it resolves for two or more years.</p></div>
        </>}
    </section>;
  }

  if (!definition) return <section className="nz-panel">{head}<Empty text="That metric is no longer defined for this client." /></section>;
  const resolved = years.map((year) => ({ year, intensity: intensityFor(year, definition) }))
    .filter((entry) => entry.intensity.state === "resolved") as Array<{ year: ClientYearFigure; intensity: Extract<ResolvedIntensity, { state: "resolved" }> }>;

  return <section className="nz-panel">{head}
    {resolved.length < 2
      ? <div className="nz-card-b">
        <p className="sub" style={{ margin: "8px 0" }}>{resolved.length === 1
          ? `Only ${fyLabel(resolved[0]!.year.year)} resolves on this metric — a trend needs two years.`
          : "No reporting year resolves on this metric."}</p>
        <MetricReasons years={years} definition={definition} />
      </div>
      : <>
        <IntensityPathway showChrome={false} data={{
          spec: { id: `client-intensity-${clientId}-${definition.key}`, type: "intensity_pathway", title: `Emissions intensity per ${definition.unitWording}`, family: "crp", specVersion: 1 },
          unit: resolved[resolved.length - 1]!.intensity.unitShort, state: "success",
          metric: definition.key === "turnover" ? "turnover" : definition.valueSource === "site-floor-area" ? "floor-area" : "employee",
          actual: resolved.map((entry) => ({ year: entry.year.year, value: entry.intensity.value })),
          target: [], milestones: [],
          provenance: provenance(years[years.length - 1]!.snapshotId, years[years.length - 1]!.jobId),
        }} />
        <div className="nz-card-b">
          {years.slice().reverse().map((year) => {
            const intensity = intensityFor(year, definition);
            return <div className="nz-cw-kv" key={year.snapshotId}>
              <span className="k">{fyLabel(year.year)}</span>
              <span className="v">{intensity.state === "resolved"
                ? `${figure(intensity.value)} ${intensity.unitShort}`
                : <span className="muted" title={intensity.reason}>Unavailable</span>}</span>
            </div>;
          })}
        </div>
      </>}
  </section>;
}

/** Why a metric does not resolve — the reason, never a silent gap. */
function MetricReasons({ years, definition }: { years: ClientYearFigure[]; definition: IntensityMetricDefinition }) {
  const reasons = Array.from(new Set(years.map((year) => intensityFor(year, definition))
    .filter((intensity) => intensity.state === "unavailable")
    .map((intensity) => (intensity as Extract<ResolvedIntensity, { state: "unavailable" }>).reason)));
  return <>{reasons.map((reason) => <p className="nz-maps" key={reason}>{reason}</p>)}</>;
}

function IntensityDetail({ year, years, metrics, metricKey, onEvidence, manage }: {
  year: ClientYearFigure | null;
  years: ClientYearFigure[];
  metrics: IntensityMetricDefinition[];
  metricKey: string;
  onEvidence: () => void;
  manage: React.ReactNode;
}) {
  const head = <CardHead eyebrow={year ? fyLabel(year.year) : "Latest"} title="Intensity detail" right={<EvidenceButton label="Intensity detail" onOpen={onEvidence} />} />;
  const maps = <p className="nz-maps">Metrics are defined on the client — Employees and Turnover are standard, plus any additionals — and the annual values are recorded on each job. A metric with no value for a year reads unavailable rather than being estimated. {manage}</p>;

  if (metricKey === ALL || !year) {
    return <section className="nz-panel">{head}
      <div className="nz-card-b">
        {year ? metrics.map((metric) => {
          const intensity = intensityFor(year, metric);
          return <div className="nz-cw-kv" key={metric.key}>
            <span className="k"><IntensityMetricIcon iconKey={metric.iconKey} size={14} style={{ marginRight: 6, verticalAlign: "-2px" }} />Intensity · per {metric.unitWording}</span>
            <span className="v">{intensity.state === "resolved" ? `${figure(intensity.value)} ${intensity.unitShort}` : <span className="muted" title={intensity.reason}>Unavailable</span>}</span>
          </div>;
        }) : null}
        {maps}
      </div>
    </section>;
  }

  const definition = metrics.find((metric) => metric.key === metricKey);
  if (!definition) return <section className="nz-panel">{head}<div className="nz-card-b">{maps}</div></section>;
  const current = intensityFor(year, definition);
  const earliest = years.map((entry) => ({ entry, intensity: intensityFor(entry, definition) }))
    .find((item) => item.intensity.state === "resolved");
  const comparable = earliest && earliest.entry.year !== year.year && current.state === "resolved" && earliest.intensity.state === "resolved";
  const change = comparable && current.state === "resolved" && earliest!.intensity.state === "resolved"
    ? ((current.value - earliest!.intensity.value) / earliest!.intensity.value) * 100 : null;

  return <section className="nz-panel">{head}
    <div className="nz-card-b">
      <div className="nz-cw-kv"><span className="k"><IntensityMetricIcon iconKey={definition.iconKey} size={14} style={{ marginRight: 6, verticalAlign: "-2px" }} />Intensity · per {definition.unitWording}</span>
        <span className="v">{current.state === "resolved" ? `${figure(current.value)} ${current.unitShort}` : <span className="muted">Unavailable</span>}</span></div>
      <div className="nz-cw-kv"><span className="k">vs {earliest ? fyLabel(earliest.entry.year) : "earlier year"}</span>
        <span className={`v${change === null ? "" : change <= 0 ? " ok" : " up"}`}>{change === null
          ? <span className="muted">{current.state === "resolved" ? "No earlier year on this metric" : "—"}</span>
          : `${change <= 0 ? "−" : "+"}${Math.abs(change).toFixed(1)}%`}</span></div>
      <div className="nz-cw-kv"><span className="k">{definition.label}</span>
        <span className="v">{current.state === "resolved"
          ? `${current.denominator.toLocaleString("en-GB", { maximumFractionDigits: 2 })} ${definition.unitWording}${current.source === "site-floor-area" ? " · in-service sites" : ""}`
          : <span className="muted">Not recorded</span>}</span></div>
      {current.state === "unavailable" ? <p className="sub" style={{ margin: "8px 0 0" }}>{current.reason}</p> : null}
      {maps}
    </div>
  </section>;
}

const share = (value: number, total: number | null) => total && total > 0 ? `${Math.round((value / total) * 100)}%` : "—";
export { intensityUnitShort };
