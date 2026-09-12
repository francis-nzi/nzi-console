"use client";

import { useState } from "react";
import { CRP_RESOLVER_VERSION, EmissionsScopeDonut, IntensityBasesIndexed, IntensityPathway, RENDERER_VERSION, ScopeYearOnYearBar, TOKENS_VERSION } from "@nzi/charts";
import type { ClientIntensityBasis, ClientWorkspaceReadModel, ClientYearFigure, IntensityBasisKey } from "@nzi/isolated-backend";
import { ClientPathway } from "./ClientPathway";
import { CardHead, Empty } from "./OverviewArea";
import { EvidenceButton, TierBadge, fyLabel, tonnes } from "./FigureEvidence";

/**
 * Carbon Analytics (client workspace v10). Every series is resolved from the client's own
 * assured years — the same snapshots the headline figures read — and every figure keeps
 * its evidence one click away. A basis that cannot be resolved says why; none is inferred
 * from a different denominator.
 */

type BasisChoice = IntensityBasisKey | "all";
/** The chart identity a client-screen figure carries — the reviewed snapshot it resolved from. */
type ChartProvenance = {
  jobId: string; dataHash: string; factorSets: string[]; generatedAt: string; reviewedSnapshotId: string;
  resolverVersion: number; tokensVersion: number; rendererVersion: number;
};
const BASIS_OPTIONS: Array<{ value: BasisChoice; label: string }> = [
  { value: "turnover", label: "per £M revenue" },
  { value: "employee", label: "per employee (FTE)" },
  { value: "floor-area", label: "per m² floor area" },
  { value: "all", label: "All bases (indexed)" },
];
const BASIS_LABEL: Record<IntensityBasisKey, string> = { turnover: "per revenue", employee: "per FTE", "floor-area": "per m²" };
const CHART_METRIC: Record<IntensityBasisKey, "turnover" | "employee" | "floor-area"> = { turnover: "turnover", employee: "employee", "floor-area": "floor-area" };
const resolvedBasis = (year: ClientYearFigure, key: IntensityBasisKey) => {
  const basis = year.bases[key];
  return basis.state === "resolved" ? basis : null;
};
const figure = (value: number) => value >= 100 ? Math.round(value).toLocaleString("en-GB") : value.toLocaleString("en-GB", { maximumFractionDigits: 2 });

export function AnalyticsArea({ workspace, onEvidence }: { workspace: ClientWorkspaceReadModel; onEvidence: (key: "latest" | "scopes" | "intensity" | "yoy") => void }) {
  const { client, history, evidence, targets, actuals } = workspace;
  const years = [...history].sort((a, b) => a.year - b.year);
  const [pickedYear, setPickedYear] = useState<number | null>(null);
  const [basis, setBasis] = useState<BasisChoice>("turnover");
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
        {/* Year on year, by scope. */}
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

        <IntensityChart years={years} basis={basis} onBasis={setBasis} clientId={client.id} provenance={provenance} />

        <ClientPathway client={{ id: client.id, name: client.name }} targets={targets} actuals={actuals ?? []} />
      </div>

      <div className="nz-cw-col">
        {/* Scope split, for the year chosen in the view header. */}
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
            <div className="nz-cw-kv"><span className="k"><b>Total</b></span><span className="v"><b>{selected?.totalTco2e === null || !selected ? "—" : tonnes(selected.totalTco2e)}</b></span></div>
            {selected && !selected.provenance ? <p className="nz-maps">This year&apos;s snapshot carries no factor-set stamp, so its signature cannot be shown. The figures are unaffected.</p> : null}
          </div>
        </section>

        <IntensityDetail year={selected} years={years} basis={basis} note={evidence.intensity.note} onEvidence={() => onEvidence("intensity")} />
      </div>
    </div>
  </>;
}

/** The intensity chart and its basis picker. Each basis has its own denominator and unit. */
function IntensityChart({ years, basis, onBasis, clientId, provenance }: {
  years: ClientYearFigure[]; basis: BasisChoice; onBasis: (basis: BasisChoice) => void; clientId: string;
  provenance: (snapshotId: string, jobId: string) => ChartProvenance;
}) {
  const picker = <>
    <select className="nz-sel" value={basis} onChange={(event) => onBasis(event.target.value as BasisChoice)} aria-label="Intensity basis" style={{ marginRight: 8 }}>
      {BASIS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    <span className="hint">{basis === "all" ? "indexed · base = 100" : unitFor(years, basis) ?? "no denominator"}</span>
  </>;
  const head = <CardHead eyebrow="Year on year" title="Emissions intensity" right={picker} />;

  if (basis === "all") {
    // Each basis is indexed to the earliest year that basis resolves — its own base — so
    // the three shapes are comparable even when they start in different years.
    const plotted = (["turnover", "employee", "floor-area"] as const).map((key) => ({
      key, label: key === "turnover" ? "Revenue" : key === "employee" ? "FTE" : "Floor area",
      resolved: years.map((year) => ({ year: year.year, basis: resolvedBasis(year, key) })).filter((entry) => entry.basis !== null),
    })).filter((entry) => entry.resolved.length >= 2);
    // An index only claims a shared base year when every plotted basis resolves in it;
    // otherwise each carries its own first year and the chart says so.
    const commonBase = years.map((year) => year.year).find((year) => plotted.every((entry) => entry.resolved.some((point) => point.year === year))) ?? null;
    const series = plotted.map((entry) => {
      const base = (commonBase === null ? entry.resolved[0] : entry.resolved.find((point) => point.year === commonBase))!;
      return {
        key: entry.key, label: entry.label,
        points: entry.resolved.map((point) => ({ year: point.year, value: (point.basis!.value / base.basis!.value) * 100, absolute: point.basis!.value, absoluteUnit: point.basis!.unit })),
      };
    });
    const baseYear = commonBase;
    return <section className="nz-panel">{head}
      {series.length === 0
        ? <Empty text="No basis resolves for two or more years yet, so there is nothing to index. Each basis needs its denominator recorded on at least two reporting years." />
        : <>
          <IntensityBasesIndexed showChrome={false} data={{
            spec: { id: `client-intensity-bases-${clientId}`, type: "intensity_bases_indexed", title: "Emissions intensity — all bases, indexed", family: "crp", specVersion: 1 },
            unit: "index", state: "success", baseYear, series,
            provenance: provenance(years[years.length - 1]!.snapshotId, years[years.length - 1]!.jobId),
          }} />
          <div className="nz-card-b"><p className="nz-maps">Each basis has its own denominator and unit, so they share an axis only as an index{baseYear === null
            ? " — and because no single year resolves on every basis here, each is indexed to its own first year, so compare the shapes rather than the levels"
            : ` (${baseYear} = 100)`}. A basis is plotted only where it resolves for two or more years.</p></div>
        </>}
    </section>;
  }

  const resolved = years.map((year) => ({ year, basis: resolvedBasis(year, basis) })).filter((entry) => entry.basis !== null);
  return <section className="nz-panel">{head}
    {resolved.length < 2
      ? <div className="nz-card-b">
        <p className="sub" style={{ margin: "8px 0" }}>{resolved.length === 1
          ? `Only ${fyLabel(resolved[0]!.year.year)} resolves on this basis — a trend needs two years.`
          : "No reporting year resolves on this basis."}</p>
        <BasisReasons years={years} basis={basis} />
      </div>
      : <>
        <IntensityPathway showChrome={false} data={{
          spec: { id: `client-intensity-${clientId}-${basis}`, type: "intensity_pathway", title: `Emissions intensity ${BASIS_LABEL[basis]}`, family: "crp", specVersion: 1 },
          unit: resolved[resolved.length - 1]!.basis!.unit, state: "success", metric: CHART_METRIC[basis],
          actual: resolved.map((entry) => ({ year: entry.year.year, value: entry.basis!.value })),
          target: [], milestones: [],
          provenance: provenance(years[years.length - 1]!.snapshotId, years[years.length - 1]!.jobId),
        }} />
        <div className="nz-card-b">
          {years.slice().reverse().map((year) => <div className="nz-cw-kv" key={year.snapshotId}>
            <span className="k">{fyLabel(year.year)}</span>
            <span className="v">{year.bases[basis].state === "resolved"
              ? `${figure((year.bases[basis] as Extract<ClientIntensityBasis, { state: "resolved" }>).value)} ${(year.bases[basis] as Extract<ClientIntensityBasis, { state: "resolved" }>).unit}`
              : <span className="muted" title={(year.bases[basis] as Extract<ClientIntensityBasis, { state: "unavailable" }>).reason}>Unavailable</span>}</span>
          </div>)}
        </div>
      </>}
  </section>;
}

/** Why a basis does not resolve — the reason, per year, never a silent gap. */
function BasisReasons({ years, basis }: { years: ClientYearFigure[]; basis: IntensityBasisKey }) {
  const reasons = Array.from(new Set(years.map((year) => year.bases[basis]).filter((entry) => entry.state === "unavailable").map((entry) => (entry as Extract<ClientIntensityBasis, { state: "unavailable" }>).reason)));
  return <>{reasons.map((reason) => <p className="nz-maps" key={reason}>{reason}</p>)}</>;
}

/** The picked year on the picked basis, against the earliest year the basis resolves. */
function IntensityDetail({ year, years, basis, note, onEvidence }: {
  year: ClientYearFigure | null; years: ClientYearFigure[]; basis: BasisChoice; note: string | null; onEvidence: () => void;
}) {
  const head = <CardHead eyebrow={year ? fyLabel(year.year) : "Latest"} title="Intensity detail" right={<EvidenceButton label="Intensity detail" onOpen={onEvidence} />} />;
  const maps = <p className="nz-maps">Turnover and employees come from the job&apos;s business metrics; floor area is summed from the client&apos;s in-service sites for the year (effective-dated). A basis with no denominator reads unavailable rather than being estimated from another.</p>;

  if (basis === "all") {
    return <section className="nz-panel">{head}
      <div className="nz-card-b">
        {year ? (["turnover", "employee", "floor-area"] as const).map((key) => {
          const resolved = resolvedBasis(year, key);
          return <div className="nz-cw-kv" key={key}>
            <span className="k">Intensity · {BASIS_LABEL[key]}</span>
            <span className="v">{resolved ? `${figure(resolved.value)} ${resolved.unit}` : <span className="muted" title={(year.bases[key] as Extract<ClientIntensityBasis, { state: "unavailable" }>).reason}>Unavailable</span>}</span>
          </div>;
        }) : null}
        {maps}
      </div>
    </section>;
  }

  const current = year ? resolvedBasis(year, basis) : null;
  const earliest = years.map((entry) => ({ entry, basis: resolvedBasis(entry, basis) })).find((item) => item.basis !== null);
  const comparable = earliest && year && earliest.entry.year !== year.year && current;
  const change = comparable ? ((current.value - earliest.basis!.value) / earliest.basis!.value) * 100 : null;

  return <section className="nz-panel">{head}
    <div className="nz-card-b">
      <div className="nz-cw-kv"><span className="k">Intensity · {BASIS_LABEL[basis]}</span>
        <span className="v">{current ? `${figure(current.value)} ${current.unit}` : <span className="muted">Unavailable</span>}</span></div>
      <div className="nz-cw-kv"><span className="k">vs {earliest ? fyLabel(earliest.entry.year) : "earlier year"}</span>
        <span className={`v${change === null ? "" : change <= 0 ? " ok" : " up"}`}>{change === null
          ? <span className="muted">{current ? "No earlier year on this basis" : "—"}</span>
          : `${change <= 0 ? "−" : "+"}${Math.abs(change).toFixed(1)}%`}</span></div>
      <div className="nz-cw-kv"><span className="k">{current ? current.denominatorLabel : "Denominator"}</span>
        <span className="v">{current
          ? `${current.denominator.toLocaleString("en-GB", { maximumFractionDigits: 2 })} ${current.denominatorUnit}${current.source === "site-floor-area" ? " · in-service sites" : ""}`
          : <span className="muted">Not recorded</span>}</span></div>
      {current ? null : <p className="sub" style={{ margin: "8px 0 0" }}>{year ? (year.bases[basis] as Extract<ClientIntensityBasis, { state: "unavailable" }>).reason : note ?? ""}</p>}
      {maps}
    </div>
  </section>;
}

const unitFor = (years: ClientYearFigure[], basis: IntensityBasisKey) => {
  for (let index = years.length - 1; index >= 0; index -= 1) {
    const resolved = resolvedBasis(years[index]!, basis);
    if (resolved) return resolved.unit;
  }
  return null;
};
const share = (value: number, total: number | null) => total && total > 0 ? `${Math.round((value / total) * 100)}%` : "—";
