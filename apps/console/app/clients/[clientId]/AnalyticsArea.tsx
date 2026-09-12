"use client";

import { useState } from "react";
import { CRP_RESOLVER_VERSION, EmissionsScopeDonut, IntensityPathway, RENDERER_VERSION, ScopeYearOnYearBar, TOKENS_VERSION } from "@nzi/charts";
import type { ClientWorkspaceReadModel } from "@nzi/isolated-backend";
import { ClientPathway } from "./ClientPathway";
import { CardHead, Empty } from "./OverviewArea";
import { EvidenceButton, TierBadge, fyLabel, tonnes } from "./FigureEvidence";

/**
 * Carbon Analytics (client workspace v10). Every series is resolved from the client's own
 * assured years — the same snapshots the headline figures read — and every figure keeps
 * its evidence one click away. A basis that cannot be resolved says so; none is inferred.
 */
export function AnalyticsArea({ workspace, onEvidence }: { workspace: ClientWorkspaceReadModel; onEvidence: (key: "latest" | "scopes" | "intensity" | "yoy") => void }) {
  const { client, history, evidence, targets, actuals } = workspace;
  const years = [...history].sort((a, b) => a.year - b.year);
  const [pickedYear, setPickedYear] = useState<number | null>(null);
  const selected = history.find((year) => year.year === pickedYear) ?? history[0] ?? null;

  if (history.length === 0) {
    return <section className="nz-panel">
      <CardHead eyebrow="Carbon" title="Carbon analytics" />
      <Empty text="No reviewed snapshot has been issued for this client, so there is nothing to analyse yet. Figures appear here once a CRP job issues its first assured year." />
    </section>;
  }

  const provenance = (snapshotId: string, jobId: string) => ({
    jobId, dataHash: "", factorSets: [], generatedAt: "", reviewedSnapshotId: snapshotId,
    resolverVersion: CRP_RESOLVER_VERSION, tokensVersion: TOKENS_VERSION, rendererVersion: RENDERER_VERSION,
  });

  // The bases the client's own data can actually support, per year.
  const intensityYears = years.filter((year) => year.intensity.state === "resolved" && year.intensity.value !== null);
  const intensityMetric = intensityYears[intensityYears.length - 1]?.intensity;

  return <>
    <div className="nz-cw-vhead"><div><div className="eyebrow">Carbon</div><h2>Carbon analytics</h2></div><span style={{ flex: 1 }} />
      <span className="sub">{history.length} assured year{history.length === 1 ? "" : "s"} · newest {fyLabel(history[0]!.year)}</span></div>
    <p className="nz-cw-vsub">Scope split, year-on-year change, intensity and the reduction pathway — every figure resolved from this client&apos;s reviewed snapshots, with its provenance one click away.</p>

    <div className="nz-cw-grid">
      <div className="nz-cw-col">
        {/* Scope split, for a year the user chooses. */}
        <section className="nz-panel">
          <CardHead eyebrow={selected ? fyLabel(selected.year) : "Latest"} title="Scope split" right={<EvidenceButton label="Scope split" onOpen={() => onEvidence("scopes")} />} />
          <div className="nz-card-b" style={{ paddingBottom: 0 }}>
            <label className="nz-fl" style={{ margin: 0 }}><span>Reporting year</span>
              <select className="nz-sel" value={selected?.year ?? ""} onChange={(event) => setPickedYear(Number(event.target.value))} aria-label="Reporting year">
                {history.map((year) => <option key={year.snapshotId} value={year.year}>{fyLabel(year.year)} · {year.jobNumber}</option>)}
              </select>
            </label>
          </div>
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
            {selected && !selected.provenance ? <p className="nz-maps">This year&apos;s snapshot carries no factor-set stamp, so its signature cannot be shown. The figures are unaffected.</p> : null}
          </div>
        </section>

        {/* Year on year, by scope. */}
        <section className="nz-panel">
          <CardHead eyebrow="Trend" title="Year on year by scope" right={<EvidenceButton label="Year on year" onOpen={() => onEvidence("yoy")} />} />
          {years.length < 2
            ? <Empty text="One assured year so far — a year-on-year comparison needs two." />
            : <ScopeYearOnYearBar showChrome={false} data={{
              spec: { id: `client-yoy-${client.id}`, type: "scope_year_on_year_bar", title: "Annual emissions by scope", family: "crp", specVersion: 1 },
              unit: "tCO₂e", state: "success",
              years: years.map((year) => ({ year: year.year, values: year.scopes.map((scope) => ({ scope: scope.scope, value: scope.tco2e ?? 0 })) })),
              provenance: provenance(years[years.length - 1]!.snapshotId, years[years.length - 1]!.jobId),
            }} />}
        </section>
      </div>

      <div className="nz-cw-col">
        <ClientPathway client={{ id: client.id, name: client.name }} targets={targets} actuals={actuals ?? []} />

        {/* Intensity: the bases this client's own data supports. */}
        <section className="nz-panel">
          <CardHead eyebrow="Normalised" title="Intensity" right={<EvidenceButton label="Intensity detail" onOpen={() => onEvidence("intensity")} />} />
          {intensityYears.length === 0
            ? <div className="nz-card-b"><p className="sub" style={{ margin: "8px 0" }}>{evidence.intensity.note ?? "No intensity metric is set on this client's jobs, so there is no normalised figure to show."}</p>
              <p className="nz-maps">Turnover and employees come from a job&apos;s business metrics; floor area is summed from the client&apos;s in-service sites for the year (effective-dated).</p></div>
            : <>
              {intensityYears.length > 1
                ? <IntensityPathway showChrome={false} data={{
                  spec: { id: `client-intensity-${client.id}`, type: "intensity_pathway", title: "Intensity over time", family: "crp", specVersion: 1 },
                  unit: intensityMetric?.unit ?? "tCO₂e", state: "success",
                  metric: (intensityMetric?.metric as "turnover" | "employee" | "floor-area") ?? "turnover",
                  actual: intensityYears.map((year) => ({ year: year.year, value: year.intensity.value ?? 0 })),
                  target: [], milestones: [],
                  provenance: provenance(intensityYears[intensityYears.length - 1]!.snapshotId, intensityYears[intensityYears.length - 1]!.jobId),
                }} />
                : null}
              <div className="nz-card-b">
                {years.map((year) => <div className="nz-cw-kv" key={year.snapshotId}>
                  <span className="k">{fyLabel(year.year)}{year.intensity.metric ? ` · ${basisLabel(year.intensity.metric)}` : ""}</span>
                  <span className="v">{year.intensity.state === "resolved" && year.intensity.value !== null
                    ? `${year.intensity.value.toLocaleString("en-GB", { maximumFractionDigits: 4 })} ${year.intensity.unit}`
                    : <span className="muted">Unavailable</span>}</span>
                </div>)}
                <p className="nz-maps">A year is shown only on the basis its job recorded. A basis with no denominator reads unavailable rather than being estimated from another.</p>
              </div>
            </>}
        </section>

        {/* The assured totals themselves. */}
        <section className="nz-panel">
          <CardHead eyebrow="Assured" title="Emissions history" right={<EvidenceButton label="Latest emissions" onOpen={() => onEvidence("latest")} />} />
          <div className="nz-card-b">
            {years.slice().reverse().map((year) => <div className="nz-cw-kv" key={year.snapshotId}>
              <span className="k">{fyLabel(year.year)} · {year.jobNumber}</span>
              <span className="v">{year.totalTco2e === null ? "—" : tonnes(year.totalTco2e)}</span>
            </div>)}
          </div>
        </section>
      </div>
    </div>
  </>;
}

const share = (value: number, total: number | null) => total && total > 0 ? `${Math.round((value / total) * 100)}%` : "—";
const basisLabel = (metric: string) => metric === "floor-area" ? "per m²" : metric === "employee" ? "per FTE" : "per revenue";
