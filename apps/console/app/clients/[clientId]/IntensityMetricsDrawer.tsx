"use client";

import { useRef, useState } from "react";
import { GatedButton } from "@nzi/ui";
import { postBrowserCommand, putBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import {
  activeMetrics, intensityDividers, intensityIconKeys, intensityUnit, suggestIconKey,
  type IntensityDivider, type IntensityMetricDefinition,
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
 */

const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;

const dividerLabel = (divider: number) => `Per ${divider.toLocaleString("en-GB")}`;
const keyFrom = (label: string) => label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

export function IntensityMetricsDrawer({ clientId, metrics, access, onClose, onSaved }: {
  clientId: string;
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
      {standard.map((metric) => <MetricRow key={metric.key} metric={metric} access={access} pending={pending === metric.key}
        onSave={(changes) => void save(metric, changes)} onDeactivate={null} />)}

      <div className="nz-sect">Additional</div>
      {additional.length === 0 ? <p className="nz-hint">None yet. Add anything this client measures itself by — vehicles, water, units produced.</p> : null}
      {additional.map((metric) => <MetricRow key={metric.key} metric={metric} access={access} pending={pending === metric.key}
        onSave={(changes) => void save(metric, changes)} onDeactivate={metric.active ? () => void deactivate(metric) : null} />)}

      <NewMetric clientId={clientId} access={access} existing={metrics} onSaved={onSaved} onError={setError} />

      {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
      <div className="nz-gov"><span className="lk" aria-hidden="true">🔒</span><span>Metrics are <b>versioned</b>; the divider and icon are part of the definition. Removing a metric <b>deactivates</b> it — historical reports keep the wording they were issued with — and nothing is hard-deleted. Annual values are captured per reporting year on the job.</span></div>
    </div>
    <div className="nz-df"><span className="sp" /><button type="button" className="nz-btn pri" onClick={onClose}>Done</button></div>
  </>;
}

function MetricRow({ metric, access, pending, onSave, onDeactivate }: {
  metric: IntensityMetricDefinition;
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
        <input className="nz-inp sm" value={unitWording} onChange={(event) => setUnitWording(event.target.value)} aria-label={`${metric.label} unit wording`} style={{ maxWidth: 120 }} />
        <select className="nz-sel sm" value={divider} onChange={(event) => setDivider(Number(event.target.value) as IntensityDivider)} aria-label={`${metric.label} divider`}>
          {intensityDividers.map((option) => <option key={option} value={option}>{dividerLabel(option)}</option>)}
        </select>
        <span className="hint">{intensityUnit({ unitWording, divider })}</span>
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

function NewMetric({ clientId, access, existing, onSaved, onError }: {
  clientId: string; access: EditAccess; existing: IntensityMetricDefinition[];
  onSaved: (text: string) => void; onError: (text: string | null) => void;
}) {
  const [label, setLabel] = useState("");
  const [unitWording, setUnitWording] = useState("");
  const [divider, setDivider] = useState<IntensityDivider>(1);
  const [iconKey, setIconKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const key = useRef<string | null>(null);
  // Suggested from the name, and overridable — the suggestion updates until it is overridden.
  const suggested = suggestIconKey(label, unitWording);
  const chosen = iconKey ?? suggested;
  const metricKey = keyFrom(label);
  const clash = existing.some((metric) => metric.key === metricKey);
  const problem = !label.trim() ? "A name is needed." : !unitWording.trim() ? "A unit is needed." : clash ? "This client already has a metric with that name." : null;

  async function add() {
    setPending(true);
    onError(null);
    key.current = crypto.randomUUID();
    const result = await putBrowserCommand<{ version: number }>(
      `/api/isolated/clients/${encodeURIComponent(clientId)}/intensity-metrics`,
      { metricKey, label: label.trim(), unitWording: unitWording.trim(), divider, iconKey: chosen, ordering: existing.length + 1, expectedVersion: 0 },
      key.current);
    setPending(false);
    if (result.state !== "success") { onError(errorText(result)); return; }
    setLabel(""); setUnitWording(""); setDivider(1); setIconKey(null);
    onSaved(`${label.trim()} added.`);
  }

  return <>
    <div className="nz-sect">Add a metric</div>
    <label className="nz-fl"><span>Metric name</span>
      <input className="nz-inp" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Fleet vehicles · Water use · Units produced" />
    </label>
    <div className="nz-two">
      <label className="nz-fl"><span>Unit wording</span>
        <input className="nz-inp" value={unitWording} onChange={(event) => setUnitWording(event.target.value)} placeholder="e.g. vehicle · m³ · unit" />
      </label>
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
    {label.trim() ? <span className="nz-hint">Reads as <b>{intensityUnit({ unitWording: unitWording || "unit", divider })}</b>.</span> : null}
    <GatedButton className="nz-btn" blocked={pending || problem !== null || access.state !== "allowed"}
      blockedReason={pending ? "Adding…" : problem ?? (access.state === "allowed" ? undefined : access.reason)}
      reasonClassName="hint nz-gated-reason" onClick={() => void add()}>＋ Add metric</GatedButton>
  </>;
}

export { activeMetrics };
