"use client";

import { useRef, useState } from "react";
import { GatedButton } from "@nzi/ui";
import { postBrowserCommand, putBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import {
  activeMetrics, intensityDividers, intensityIconKeys, intensityUnit, suggestIconKey,
  type IntensityDivider, type IntensityMetricDefinition, type IntensityUnitKind,
} from "@nzi/contracts";
import type { EditAccess } from "../../lib/useEditAccess";
import { IntensityMetricIcon } from "./IntensityMetricIcon";

/**
 * Manage metrics — the client's own intensity set (client workspace v11).
 *
 * Employees and Turnover are standard: their wording, divider and icon are editable, but
 * they cannot be removed, only deactivated. Additionals are whatever the client actually
 * measures itself by. The divider is part of the definition, because "42.7 tCO₂e" means
 * nothing until you know it is per £1m.
 *
 * A metric counts either a thing (its wording names it) or money (D3c): a currency metric stores no symbol and reads
 * in the client's currency — "tCO₂e per £m" here, "tCO₂e per €m" for a client that reports in euros.
 */

const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;

const dividerLabel = (divider: number) => `Per ${divider.toLocaleString("en-GB")}`;
/** A currency metric's wording is informational only (0143) and never displayed; the column still needs one (0071). */
const CURRENCY_WORDING = "currency";
const keyFrom = (label: string) => label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

export function IntensityMetricsDrawer({ clientId, currency, metrics, access, onClose, onSaved }: {
  clientId: string;
  /** The client's currency — what a currency metric reads in. */
  currency: string;
  metrics: IntensityMetricDefinition[];
  access: EditAccess;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const standard = metrics.filter((metric) => metric.isStandard);
  const additional = metrics.filter((metric) => !metric.isStandard);

  async function save(metric: IntensityMetricDefinition, changes: Partial<IntensityMetricDefinition>) {
    setPending(metric.key);
    setError(null);
    key.current = crypto.randomUUID();
    const result = await putBrowserCommand<{ version: number }>(
      `/api/isolated/clients/${encodeURIComponent(clientId)}/intensity-metrics`,
      {
        metricKey: metric.key, label: changes.label ?? metric.label, unitWording: changes.unitWording ?? metric.unitWording,
        divider: changes.divider ?? metric.divider, iconKey: changes.iconKey ?? metric.iconKey,
        ordering: metric.ordering, expectedVersion: metric.version,
      }, key.current);
    setPending(null);
    if (result.state !== "success") { setError(errorText(result)); return; }
    onSaved(`${changes.label ?? metric.label} saved.`);
  }

  async function deactivate(metric: IntensityMetricDefinition) {
    setPending(metric.key);
    setError(null);
    key.current = crypto.randomUUID();
    const result = await postBrowserCommand<{ version: number }>(
      `/api/isolated/clients/${encodeURIComponent(clientId)}/intensity-metrics`,
      { metricKey: metric.key, expectedVersion: metric.version }, key.current);
    setPending(null);
    if (result.state !== "success") { setError(errorText(result)); return; }
    onSaved(`${metric.label} deactivated — historical reports keep it.`);
  }

  return <>
    <div className="nz-dh"><div className="k">Carbon · reference data</div><h3>Intensity metrics</h3><button type="button" className="x" onClick={onClose} aria-label="Close">×</button></div>
    <div className="nz-db">
      <p className="nz-hint" style={{ marginTop: 0 }}>Define what this client&apos;s emissions are measured against. <b>Employees</b> and <b>Turnover</b> are standard; add any additionals the client needs. Each metric&apos;s icon and its <b>per-N</b> divider carry through to the year-on-year chart, the client portal and the report. The <b>annual values</b> are recorded on each job.</p>

      <div className="nz-sect">Standard</div>
      {standard.map((metric) => <MetricRow key={metric.key} metric={metric} currency={currency} access={access} pending={pending === metric.key}
        onSave={(changes) => void save(metric, changes)} onDeactivate={null} />)}

      <div className="nz-sect">Additional</div>
      {additional.length === 0 ? <p className="nz-hint">None yet. Add anything this client measures itself by — vehicles, water, units produced.</p> : null}
      {additional.map((metric) => <MetricRow key={metric.key} metric={metric} currency={currency} access={access} pending={pending === metric.key}
        onSave={(changes) => void save(metric, changes)} onDeactivate={metric.active ? () => void deactivate(metric) : null} />)}

      <NewMetric clientId={clientId} currency={currency} access={access} existing={metrics} onSaved={onSaved} onError={setError} />

      {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
      <div className="nz-gov"><span className="lk" aria-hidden="true">🔒</span><span>Metrics are <b>versioned</b>; the divider and icon are part of the definition. Removing a metric <b>deactivates</b> it — historical reports keep the wording they were issued with — and nothing is hard-deleted. Annual values are captured per reporting year on the job.</span></div>
    </div>
    <div className="nz-df"><span className="sp" /><button type="button" className="nz-btn pri" onClick={onClose}>Done</button></div>
  </>;
}

function MetricRow({ metric, currency, access, pending, onSave, onDeactivate }: {
  metric: IntensityMetricDefinition;
  currency: string;
  access: EditAccess;
  pending: boolean;
  onSave: (changes: Partial<IntensityMetricDefinition>) => void;
  onDeactivate: (() => void) | null;
}) {
  const [label, setLabel] = useState(metric.label);
  const [unitWording, setUnitWording] = useState(metric.unitWording);
  const [divider, setDivider] = useState<IntensityDivider>(metric.divider);
  const [iconKey, setIconKey] = useState(metric.iconKey);
  const [picking, setPicking] = useState(false);
  const dirty = label !== metric.label || unitWording !== metric.unitWording || divider !== metric.divider || iconKey !== metric.iconKey;

  return <div className={`nz-metric-row${metric.active ? "" : " off"}`}>
    <button type="button" className="nz-metric-badge" onClick={() => setPicking(!picking)} aria-label={`Change the icon for ${metric.label}`} aria-expanded={picking}>
      <IntensityMetricIcon iconKey={iconKey} size={16} />
    </button>
    <div className="nz-metric-meta">
      <div className="nz-metric-name">
        {metric.isStandard
          ? <><b>{metric.label}</b><span className="nz-tag rr">Standard</span></>
          : <input className="nz-inp sm" value={label} onChange={(event) => setLabel(event.target.value)} aria-label={`${metric.label} name`} />}
        {metric.valueSource === "site-floor-area" ? <span className="nz-tag">From sites</span> : null}
        {metric.active ? null : <span className="nz-tag">Inactive</span>}
      </div>
      <div className="nz-metric-controls">
        {metric.unitKind === "currency"
          ? <span className="hint">Counts money in {currency}</span>
          : <input className="nz-inp sm" value={unitWording} onChange={(event) => setUnitWording(event.target.value)} aria-label={`${metric.label} unit wording`} style={{ maxWidth: 120 }} />}
        <select className="nz-sel sm" value={divider} onChange={(event) => setDivider(Number(event.target.value) as IntensityDivider)} aria-label={`${metric.label} divider`}>
          {intensityDividers.map((option) => <option key={option} value={option}>{dividerLabel(option)}</option>)}
        </select>
        <span className="hint">{intensityUnit({ unitWording, divider, unitKind: metric.unitKind }, { currency })}</span>
      </div>
      {picking ? <IconPicker selected={iconKey} onPick={(next) => { setIconKey(next); setPicking(false); }} /> : null}
    </div>
    <div className="nz-metric-actions">
      <GatedButton className="nz-editlink" blocked={!dirty || pending || access.state !== "allowed"}
        blockedReason={access.state === "allowed" ? (pending ? "Saving…" : dirty ? undefined : "No change to save") : access.reason}
        reasonClassName="hint nz-gated-reason" onClick={() => onSave({ label, unitWording, divider, iconKey })}>Save</GatedButton>
      {onDeactivate ? <GatedButton className="nz-editlink nz-danger" blocked={pending || access.state !== "allowed"}
        blockedReason={access.state === "allowed" ? undefined : access.reason} reasonClassName="hint nz-gated-reason"
        onClick={onDeactivate}>Remove</GatedButton> : null}
    </div>
  </div>;
}

function IconPicker({ selected, onPick }: { selected: string; onPick: (key: string) => void }) {
  return <div className="nz-icon-pick" role="group" aria-label="Choose an icon">
    {intensityIconKeys.map((key) => <button key={key} type="button" className={`nz-icon-opt${key === selected ? " on" : ""}`}
      onClick={() => onPick(key)} aria-label={key} aria-pressed={key === selected}>
      <IntensityMetricIcon iconKey={key} size={16} />
    </button>)}
  </div>;
}

function NewMetric({ clientId, currency, access, existing, onSaved, onError }: {
  clientId: string; currency: string; access: EditAccess; existing: IntensityMetricDefinition[];
  onSaved: (text: string) => void; onError: (text: string | null) => void;
}) {
  const [label, setLabel] = useState("");
  const [unitWording, setUnitWording] = useState("");
  const [unitKind, setUnitKind] = useState<IntensityUnitKind>("text");
  const [divider, setDivider] = useState<IntensityDivider>(1);
  const [iconKey, setIconKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const money = unitKind === "currency";
  const key = useRef<string | null>(null);
  // Suggested from the name, and overridable — the suggestion updates until it is overridden.
  const suggested = suggestIconKey(label, unitWording);
  const chosen = iconKey ?? suggested;
  const metricKey = keyFrom(label);
  const clash = existing.some((metric) => metric.key === metricKey);
  const problem = !label.trim() ? "A name is needed." : !money && !unitWording.trim() ? "A unit is needed." : clash ? "This client already has a metric with that name." : null;

  async function add() {
    setPending(true);
    onError(null);
    key.current = crypto.randomUUID();
    const result = await putBrowserCommand<{ version: number }>(
      `/api/isolated/clients/${encodeURIComponent(clientId)}/intensity-metrics`,
      { metricKey, label: label.trim(), unitWording: money ? CURRENCY_WORDING : unitWording.trim(), unitKind, divider, iconKey: chosen, ordering: existing.length + 1, expectedVersion: 0 },
      key.current);
    setPending(false);
    if (result.state !== "success") { onError(errorText(result)); return; }
    setLabel(""); setUnitWording(""); setUnitKind("text"); setDivider(1); setIconKey(null);
    onSaved(`${label.trim()} added.`);
  }

  return <>
    <div className="nz-sect">Add a metric</div>
    <label className="nz-fl"><span>Metric name</span>
      <input className="nz-inp" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Fleet vehicles · Water use · Units produced" />
    </label>
    <label className="nz-fl"><span>Counts</span>
      <select className="nz-sel" value={unitKind} onChange={(event) => {
        const next = event.target.value as IntensityUnitKind;
        setUnitKind(next);
        // Money is almost always read per million; a thing, per one. Either can be changed.
        setDivider(next === "currency" ? 1000000 : 1);
      }}>
        <option value="text">A thing — vehicles, m³, units</option>
        <option value="currency">Money, in the client&apos;s currency ({currency})</option>
      </select>
    </label>
    <div className="nz-two">
      {money
        ? <div className="nz-fl"><span>Unit</span><span className="nz-hint" style={{ margin: 0 }}>The client&apos;s currency — values are entered as whole amounts.</span></div>
        : <label className="nz-fl"><span>Unit wording</span>
          <input className="nz-inp" value={unitWording} onChange={(event) => setUnitWording(event.target.value)} placeholder="e.g. vehicle · m³ · unit" />
        </label>}
      <label className="nz-fl"><span>Divider</span>
        <select className="nz-sel" value={divider} onChange={(event) => setDivider(Number(event.target.value) as IntensityDivider)}>
          {intensityDividers.map((option) => <option key={option} value={option}>{dividerLabel(option)}</option>)}
        </select>
      </label>
    </div>
    <div className="nz-fl">
      <span>Icon <span style={{ fontWeight: 400 }}>— suggested from the name; tap to override</span></span>
      <IconPicker selected={chosen} onPick={setIconKey} />
    </div>
    {label.trim() ? <span className="nz-hint">Reads as <b>{intensityUnit({ unitWording: unitWording || "unit", divider, unitKind }, { currency })}</b>.</span> : null}
    <GatedButton className="nz-btn" blocked={pending || problem !== null || access.state !== "allowed"}
      blockedReason={pending ? "Adding…" : problem ?? (access.state === "allowed" ? undefined : access.reason)}
      reasonClassName="hint nz-gated-reason" onClick={() => void add()}>＋ Add metric</GatedButton>
  </>;
}

export { activeMetrics };
