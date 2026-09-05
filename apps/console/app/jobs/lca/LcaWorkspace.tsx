"use client";

// Track C — LCA/PCF reference module. Behind `job-module-lca`; FamilyWorkspace
// still serves lca/pcf jobs when the flag is off.
// Slice 1 (Model Register): create/edit an assessment's header fields.
// Slice 2 (Inventory): line items grouped by EN 15804 module, manual add + BOM
// bulk-paste import, a component-library quick-pick, and per-line factor
// mapping reusing the job's shared factor library (docs/MODEL_FIDELITY_JOB_
// FAMILIES.md §2/§6/§7; NZC-053/054/056).
// Slice 3 (this file, transport legs): A2/A4/C2 line items only. Nominatim
// geocoding (`/api/isolated/lca-geocode`) estimates a distance; manual entry
// is always available and the estimate stays fully editable. Each leg's own
// `calculatedKgco2e` waits on the calc engine (L4) — honest, not a shortcut.
// Gap-filling, the calc engine, scenarios, charts and the report manifest are
// later slices.
import { Fragment, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell, TopBar, WorkspaceRail } from "@nzi/ui";
import { jobFamilyMeta, type FamilyJob } from "@nzi/mock-data";
import { postBrowserCommand } from "@nzi/api-client";
import { lcaModuleCodes, type FactorOption, type LcaAssessment, type LcaAssessmentType, type LcaComponentOption, type LcaDataQuality, type LcaLifecycleBoundary, type LcaLineItem, type LcaModuleCode, type LcaTransportLegWriteFields } from "@nzi/contracts";
import { NAV, USER } from "../../lib/nav";
import { WorkflowStageControl } from "../WorkflowStageControl";
import { fuzzyScore } from "../templateSearch";
import { lcaBomTemplateCsv, parseLcaBomLines } from "./lcaBomImport";

type Notice = { kind: "ok" | "warn"; text: string };

const MODULE_LABEL: Record<LcaModuleCode, string> = {
  A1: "A1 · Raw material supply", A2: "A2 · Transport to manufacturer", A3: "A3 · Manufacturing",
  A4: "A4 · Transport to site/user", A5: "A5 · Construction/installation",
  B1: "B1 · Use", B2: "B2 · Maintenance", B3: "B3 · Repair", B4: "B4 · Replacement",
  B5: "B5 · Refurbishment", B6: "B6 · Operational energy", B7: "B7 · Operational water",
  C1: "C1 · Deconstruction", C2: "C2 · Transport to waste", C3: "C3 · Waste processing", C4: "C4 · Disposal",
  D: "D · Benefits beyond boundary",
};

export function LcaWorkspace({ job, assessments, factors, components, categories }: {
  job: FamilyJob; assessments: LcaAssessment[]; factors: FactorOption[];
  components: LcaComponentOption[]; categories: { id: string; name: string }[];
}) {
  const { header } = job;
  const meta = jobFamilyMeta[header.family];
  const [notice, setNotice] = useState<Notice | null>(null);
  const [creating, setCreating] = useState(assessments.length === 0);
  const [expandedId, setExpandedId] = useState<string | null>(assessments.length === 1 ? assessments[0]!.id : null);

  return <AppShell rail={<WorkspaceRail sections={NAV} activeId="jobs" user={USER} />}>
    <TopBar searchPlaceholder={`Search ${meta.code} job…`} crumbs={<>Engagements <span className="muted">/</span> <b>{header.number}</b></>} />
    <div className="nz-head nz-family-head">
      <div className="nz-job-heading">
        <div>
          <div className="nz-family-titleline"><span className="nz-eyebrow">{meta.label}</span><span className="nz-st est">{meta.code}</span></div>
          <h1>{header.number} — {header.title}</h1>
          <div className="sub">{header.client} · owner: {header.owner} · due {header.dueDate}</div>
        </div>
        <span className="nz-status"><span className="d" />{header.workflowStage}</span>
      </div>
    </div>
    <WorkflowStageControl job={job} />
    <div className="nz-body nz-family-body">
      {notice && <div className={`nz-banner ${notice.kind}`} role={notice.kind === "warn" ? "alert" : "status"}>{notice.text}</div>}
      <section className="nz-panel nz-config-panel" id="lca-assessment-register">
        <div className="nz-config-head">
          <div>
            <span className="nz-eyebrow">Model Register</span>
            <b>LCA assessments</b>
            <div className="sub">Each assessment is one modelled variant (e.g. a 6 L vs a 9 L product). PCF is a preset — ISO 14067, cradle-to-gate.</div>
          </div>
          <span className="nz-st done">{assessments.length} assessment{assessments.length === 1 ? "" : "s"}</span>
        </div>

        {assessments.length === 0 ? (
          <div className="nz-table-empty">No assessments yet — add the first one below.</div>
        ) : (
          <div className="nz-table-wrap">
            <table className="nz-tbl">
              <thead><tr><th>Name</th><th>Type</th><th>Functional unit</th><th>Boundary</th><th>Modules</th><th className="num">tCO₂e</th><th>Review</th><th /></tr></thead>
              <tbody>
                {assessments.map((assessment) => {
                  const open = expandedId === assessment.id;
                  return (
                    <Fragment key={assessment.id}>
                      <tr>
                        <td><b>{assessment.name}</b>{assessment.sku ? <div className="muted">SKU {assessment.sku}</div> : null}{assessment.isPcf ? <span className="nz-chip-mini todo" style={{ marginLeft: 6 }}>PCF</span> : null}</td>
                        <td>{assessment.assessmentType}</td>
                        <td>{assessment.functionalUnitValue} {assessment.functionalUnitUnit}</td>
                        <td>{assessment.lifecycleBoundary.replaceAll("_", " ")}</td>
                        <td>{assessment.includedModules.join(", ")}</td>
                        <td className="num">{assessment.totalTco2e.toLocaleString("en-GB", { maximumFractionDigits: 2 })}</td>
                        <td><span className={`nz-st ${assessment.reviewStatus === "approved" ? "done" : assessment.reviewStatus === "rejected" ? "nof" : "est"}`}>{assessment.reviewStatus}</span></td>
                        <td><button type="button" className="nz-btn" aria-expanded={open} onClick={() => setExpandedId(open ? null : assessment.id)}>{open ? "Close" : `Inventory (${assessment.lines.length})`}</button></td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={8} className="nz-lca-inventory-cell">
                            <AssessmentInventory jobId={header.id} assessment={assessment} factors={factors} components={components} categories={categories} notice={setNotice} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="nz-acc-foot">
          <button type="button" className="nz-btn pri" aria-expanded={creating} onClick={() => setCreating((current) => !current)}>
            {creating ? "Close" : "+ Add assessment"}
          </button>
        </div>
        {creating && <NewAssessmentForm jobId={header.id} onDone={() => setCreating(false)} notice={setNotice} />}
      </section>

      <section className="nz-panel nz-family-detail">
        <div className="nz-config-head">
          <div>
            <span className="nz-eyebrow">Coming next</span>
            <h2>Transport legs, gap-filling + recalculation, scenarios, module-breakdown chart and the report manifest</h2>
            <p>{meta.description}. The Model Register and the flat inventory (slices 1–2) are built — the rest lands behind the same flag as it is built.</p>
          </div>
        </div>
      </section>
    </div>
  </AppShell>;
}

function NewAssessmentForm({ jobId, onDone, notice }: { jobId: string; onDone: () => void; notice: (n: Notice) => void }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [value, setValue] = useState({
    assessmentType: "product" as LcaAssessmentType,
    name: "", sku: "",
    functionalUnitValue: 1, functionalUnitUnit: "unit",
    lifecycleBoundary: "cradle_to_gate" as LcaLifecycleBoundary,
    includedModules: new Set<LcaModuleCode>(["A1", "A2", "A3"]),
    standard: "ISO 14067", referenceYear: new Date().getUTCFullYear(), geography: "GB",
  });

  function toggleModule(code: LcaModuleCode) {
    setValue((current) => {
      const next = new Set(current.includedModules);
      next.has(code) ? next.delete(code) : next.add(code);
      return { ...current, includedModules: next };
    });
  }

  async function create() {
    if (pending || !value.name.trim() || value.includedModules.size === 0) return;
    setPending(true);
    const result = await postBrowserCommand<{ assessmentId: string; version: number }>(
      `/api/isolated/jobs/${jobId}/lca-assessments`,
      {
        assessmentType: value.assessmentType, name: value.name.trim(), sku: value.sku.trim() || null,
        functionalUnitValue: Number(value.functionalUnitValue), functionalUnitUnit: value.functionalUnitUnit.trim(),
        lifecycleBoundary: value.lifecycleBoundary, includedModules: [...value.includedModules],
        standard: value.standard.trim() || "ISO 14067", referenceYear: value.referenceYear || null, geography: value.geography.trim() || null,
      },
      crypto.randomUUID(),
    );
    setPending(false);
    if (result.state !== "success") {
      notice({ kind: "warn", text: result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ") : result.message });
      return;
    }
    notice({ kind: "ok", text: `${value.name} added to the Model Register.` });
    onDone();
    router.refresh();
  }

  return (
    <div className="nz-acc-extra">
      <div className="nz-config-grid lca">
        <label className="nz-fl">Name<input className="nz-inp" value={value.name} onChange={(e) => setValue({ ...value, name: e.target.value })} placeholder="e.g. 6 L variant" /></label>
        <label className="nz-fl">SKU<input className="nz-inp" value={value.sku} onChange={(e) => setValue({ ...value, sku: e.target.value })} placeholder="Optional" /></label>
        <label className="nz-fl">Type
          <select className="nz-sel" value={value.assessmentType} onChange={(e) => setValue({ ...value, assessmentType: e.target.value as LcaAssessmentType })}>
            <option value="product">Product</option>
            <option value="service">Service</option>
          </select>
        </label>
        <label className="nz-fl">Boundary
          <select className="nz-sel" value={value.lifecycleBoundary} onChange={(e) => setValue({ ...value, lifecycleBoundary: e.target.value as LcaLifecycleBoundary })}>
            <option value="cradle_to_gate">Cradle to gate</option>
            <option value="cradle_to_grave">Cradle to grave</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label className="nz-fl">Functional unit value<input className="nz-inp" type="number" min="0" step="any" value={value.functionalUnitValue} onChange={(e) => setValue({ ...value, functionalUnitValue: Number(e.target.value) })} /></label>
        <label className="nz-fl">Functional unit<input className="nz-inp" value={value.functionalUnitUnit} onChange={(e) => setValue({ ...value, functionalUnitUnit: e.target.value })} /></label>
        <label className="nz-fl">Standard<input className="nz-inp" value={value.standard} onChange={(e) => setValue({ ...value, standard: e.target.value })} /></label>
        <label className="nz-fl">Reference year<input className="nz-inp" type="number" value={value.referenceYear} onChange={(e) => setValue({ ...value, referenceYear: Number(e.target.value) })} /></label>
        <label className="nz-fl">Geography<input className="nz-inp" value={value.geography} onChange={(e) => setValue({ ...value, geography: e.target.value })} /></label>
      </div>
      <div className="nz-sect">Included EN 15804 modules</div>
      <div className="nz-lca-modules">
        {lcaModuleCodes.map((code) => (
          <label key={code} className="nz-lca-module-chip">
            <input type="checkbox" checked={value.includedModules.has(code)} onChange={() => toggleModule(code)} />
            {MODULE_LABEL[code]}
          </label>
        ))}
      </div>
      <div className="nz-config-actions">
        <button type="button" className="nz-btn" onClick={onDone}>Cancel</button>
        <button type="button" className="nz-btn pri" disabled={pending || !value.name.trim() || value.includedModules.size === 0} onClick={() => void create()}>
          {pending ? "Adding…" : "Add assessment"}
        </button>
      </div>
    </div>
  );
}

// ── Slice 2: the flat inventory ─────────────────────────────────────────────

const FACTOR_STATUS: Record<string, { cls: string; label: string }> = {
  unmapped: { cls: "need", label: "Unmapped" },
  manual: { cls: "est", label: "Manual value" },
  dataset: { cls: "done", label: "Mapped" },
  client: { cls: "done", label: "Mapped (client)" },
};

/** L3 — transport legs only belong to these modules (transport to manufacturer/site/waste). */
const TRANSPORT_MODULES: readonly LcaModuleCode[] = ["A2", "A4", "C2"];

function AssessmentInventory({ jobId, assessment, factors, components, categories, notice }: {
  jobId: string; assessment: LcaAssessment; factors: FactorOption[];
  components: LcaComponentOption[]; categories: { id: string; name: string }[]; notice: (n: Notice) => void;
}) {
  const router = useRouter();
  const [formOpen, setFormOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedLegsId, setExpandedLegsId] = useState<string | null>(null);
  const modules = useMemo(() => lcaModuleCodes.filter((code) => assessment.includedModules.includes(code)), [assessment.includedModules]);
  const linesByModule = useMemo(() => {
    const map = new Map<LcaModuleCode, LcaLineItem[]>();
    for (const code of modules) map.set(code, assessment.lines.filter((line) => line.moduleCode === code));
    return map;
  }, [modules, assessment.lines]);

  async function removeLine(lineItemId: string, label: string) {
    if (busyId || !window.confirm(`Delete "${label}"?`)) return;
    setBusyId(lineItemId);
    try {
      const response = await fetch(`/api/isolated/jobs/${jobId}/lca-assessments/${assessment.id}/line-items/${lineItemId}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({} as { message?: string }));
      if (!response.ok) throw new Error(body.message ?? "The line item could not be deleted.");
      notice({ kind: "ok", text: `${label} deleted.` });
      router.refresh();
    } catch (error) {
      notice({ kind: "warn", text: error instanceof Error ? error.message : "The line item could not be deleted." });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="nz-lca-inventory">
      <div className="nz-config-head">
        <div>
          <span className="nz-eyebrow">Inventory</span>
          <b>{assessment.name}</b>
          <div className="sub">{assessment.lines.length} line item{assessment.lines.length === 1 ? "" : "s"} across {modules.length} included module{modules.length === 1 ? "" : "s"}.</div>
        </div>
      </div>

      {modules.map((code) => {
        const lines = linesByModule.get(code) ?? [];
        return (
          <div key={code}>
            <div className="nz-acc-scopehead"><span className="sdot" style={{ background: "var(--emerald)" }} />{MODULE_LABEL[code]}</div>
            {lines.length === 0 ? (
              <div className="nz-acc-empty">No lines yet.</div>
            ) : (
              <div className="nz-table-wrap">
                <table className="nz-tbl">
                  <thead><tr><th>Line</th><th>Component</th><th className="num">Quantity</th><th>Factor</th><th className="num">kgCO₂e</th><th /></tr></thead>
                  <tbody>
                    {lines.map((line) => {
                      const status = FACTOR_STATUS[line.factorSource] ?? FACTOR_STATUS.unmapped!;
                      const component = line.componentId ? components.find((candidate) => candidate.id === line.componentId) : undefined;
                      const isTransport = TRANSPORT_MODULES.includes(line.moduleCode);
                      const legsOpen = expandedLegsId === line.id;
                      return (
                        <Fragment key={line.id}>
                          <tr>
                            <td>
                              <b>{line.lineLabel}</b>
                              {line.isPlaceholder && <span className="nz-chip-mini nodata" style={{ marginLeft: 6 }}>Excluded</span>}
                              {line.isGapFilled && <span className="nz-chip-mini todo" style={{ marginLeft: 6 }}>Gap-filled</span>}
                              {line.notes && <div className="muted">{line.notes}</div>}
                            </td>
                            <td>{component ? component.description : "—"}</td>
                            <td className="num">{line.quantity.toLocaleString("en-GB", { maximumFractionDigits: 3 })} {line.unit}</td>
                            <td>
                              <span className={`nz-st ${status.cls}`}>{status.label}</span>
                              {line.factorLabel && <div className="muted">{line.factorLabel}</div>}
                            </td>
                            <td className="num">
                              {line.calculatedKgco2e != null ? line.calculatedKgco2e.toLocaleString("en-GB", { maximumFractionDigits: 2 }) : "—"}
                              {isTransport && line.transportKgco2e > 0 && <div className="muted">+{line.transportKgco2e.toLocaleString("en-GB", { maximumFractionDigits: 2 })} transport</div>}
                            </td>
                            <td style={{ whiteSpace: "nowrap" }}>
                              {isTransport && <button type="button" className="nz-btn" aria-expanded={legsOpen} onClick={() => setExpandedLegsId(legsOpen ? null : line.id)} style={{ marginRight: 6 }}>{legsOpen ? "Close legs" : `Transport legs (${line.transportLegs.length})`}</button>}
                              <button type="button" className="nz-btn" disabled={busyId === line.id} onClick={() => void removeLine(line.id, line.lineLabel)}>{busyId === line.id ? "Deleting…" : "Delete"}</button>
                            </td>
                          </tr>
                          {isTransport && legsOpen && (
                            <tr>
                              <td colSpan={6} className="nz-lca-legs-cell">
                                <TransportLegsPanel jobId={jobId} assessmentId={assessment.id} lineItem={line} factors={factors} notice={notice} />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      <div className="nz-acc-foot">
        <button type="button" className="nz-btn pri" aria-expanded={formOpen} onClick={() => { setFormOpen((current) => !current); setBulkOpen(false); }}>{formOpen ? "Close" : "+ Add line item"}</button>
        <button type="button" className="nz-btn" aria-expanded={bulkOpen} onClick={() => { setBulkOpen((current) => !current); setFormOpen(false); }}>{bulkOpen ? "Close" : "Bulk import (BOM paste)"}</button>
      </div>
      {formOpen && <NewLineItemForm jobId={jobId} assessment={assessment} factors={factors} components={components} categories={categories} onDone={() => setFormOpen(false)} notice={notice} />}
      {bulkOpen && <BulkImportPanel jobId={jobId} assessment={assessment} onDone={() => setBulkOpen(false)} notice={notice} />}
    </div>
  );
}

// ── Slice 3: transport legs (A2/A4/C2 only) ─────────────────────────────────

const TRANSPORT_MODE_LABEL: Record<string, string> = {
  road_hgv: "Road (HGV)", road_van: "Road (van)", rail: "Rail", sea: "Sea", air: "Air", inland_water: "Inland water", other: "Other",
};
const LEG_FACTOR_STATUS: Record<string, { cls: string; label: string }> = {
  unmapped: { cls: "need", label: "Unmapped" },
  manual: { cls: "est", label: "Manual value" },
  dataset: { cls: "done", label: "Mapped" },
};

function TransportLegsPanel({ jobId, assessmentId, lineItem, factors, notice }: {
  jobId: string; assessmentId: string; lineItem: LcaLineItem; factors: FactorOption[]; notice: (n: Notice) => void;
}) {
  const router = useRouter();
  const [formOpen, setFormOpen] = useState(lineItem.transportLegs.length === 0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const base = `/api/isolated/jobs/${jobId}/lca-assessments/${assessmentId}/line-items/${lineItem.id}/transport-legs`;

  async function removeLeg(legId: string, label: string) {
    if (busyId || !window.confirm(`Delete the leg "${label}"?`)) return;
    setBusyId(legId);
    try {
      const response = await fetch(`${base}/${legId}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({} as { message?: string }));
      if (!response.ok) throw new Error(body.message ?? "The leg could not be deleted.");
      notice({ kind: "ok", text: "Transport leg deleted." });
      router.refresh();
    } catch (error) {
      notice({ kind: "warn", text: error instanceof Error ? error.message : "The leg could not be deleted." });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="nz-lca-legs">
      <div className="sub">{lineItem.lineLabel} — {lineItem.transportLegs.length} leg{lineItem.transportLegs.length === 1 ? "" : "s"}. Each leg's own emissions wait on the calc engine (L4); distances and factor mapping are captured here.</div>
      {lineItem.transportLegs.length > 0 && (
        <div className="nz-table-wrap" style={{ marginTop: 10 }}>
          <table className="nz-tbl">
            <thead><tr><th>#</th><th>From</th><th>To</th><th>Mode</th><th className="num">Distance</th><th>Factor</th><th /></tr></thead>
            <tbody>
              {lineItem.transportLegs.map((leg, index) => {
                const status = LEG_FACTOR_STATUS[leg.factorSource] ?? LEG_FACTOR_STATUS.unmapped!;
                return (
                  <tr key={leg.id}>
                    <td>{index + 1}</td>
                    <td>{leg.fromLabel}</td>
                    <td>{leg.toLabel}</td>
                    <td>{TRANSPORT_MODE_LABEL[leg.mode] ?? leg.mode}</td>
                    <td className="num">{leg.distanceKm.toLocaleString("en-GB", { maximumFractionDigits: 1 })} km<div className="muted">{leg.distanceSource === "geocoded" ? "geocoded" : "manual"}</div></td>
                    <td><span className={`nz-st ${status.cls}`}>{status.label}</span></td>
                    <td><button type="button" className="nz-btn" disabled={busyId === leg.id} onClick={() => void removeLeg(leg.id, `${leg.fromLabel} → ${leg.toLabel}`)}>{busyId === leg.id ? "Deleting…" : "Delete"}</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="nz-acc-foot">
        <button type="button" className="nz-btn pri" aria-expanded={formOpen} onClick={() => setFormOpen((current) => !current)}>{formOpen ? "Close" : "+ Add leg"}</button>
      </div>
      {formOpen && <NewTransportLegForm base={base} factors={factors} onDone={() => setFormOpen(false)} notice={notice} />}
    </div>
  );
}

function NewTransportLegForm({ base, factors, onDone, notice }: { base: string; factors: FactorOption[]; onDone: () => void; notice: (n: Notice) => void }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [value, setValue] = useState({
    fromLabel: "", toLabel: "", mode: "road_hgv" as LcaTransportLegWriteFields["mode"],
    distanceKm: 0, distanceSource: "manual" as "manual" | "geocoded",
    pickMode: "unmapped" as "unmapped" | "manual" | "search",
    datasetId: null as string | null, factorId: null as string | null, factorValue: null as number | null, factorLabel: null as string | null,
  });

  async function geocode() {
    if (geocoding || !value.fromLabel.trim() || !value.toLabel.trim()) return;
    setGeocoding(true);
    try {
      const response = await fetch("/api/isolated/lca-geocode", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ fromQuery: value.fromLabel, toQuery: value.toLabel, mode: value.mode }),
      });
      const body = await response.json().catch(() => ({} as { message?: string }));
      if (!response.ok) throw new Error(body.message ?? "Geocoding failed.");
      setValue((current) => ({ ...current, distanceKm: body.distanceKm, distanceSource: "geocoded" }));
      notice({ kind: "ok", text: `Estimated ${body.distanceKm.toLocaleString("en-GB", { maximumFractionDigits: 1 })} km (${body.source === "stub" ? "staging stub" : "Nominatim"}). Distance stays editable — override it any time.` });
    } catch (error) {
      notice({ kind: "warn", text: error instanceof Error ? error.message : "Geocoding failed — enter the distance manually." });
    } finally {
      setGeocoding(false);
    }
  }

  function pickFactor(factor: FactorOption) {
    if (factor.factorSource === "client") { notice({ kind: "warn", text: "Client factors aren't yet supported on transport legs — pick a dataset factor or enter a value manually." }); return; }
    setValue((current) => ({ ...current, datasetId: factor.datasetId, factorId: factor.factorId, factorLabel: factor.label }));
  }

  async function create() {
    if (pending || !value.fromLabel.trim() || !value.toLabel.trim()) return;
    setPending(true);
    const factorSource = value.pickMode === "unmapped" ? "unmapped" : value.pickMode === "manual" ? "manual" : "dataset";
    const result = await postBrowserCommand<{ legId: string }>(
      base,
      {
        fromLabel: value.fromLabel.trim(), toLabel: value.toLabel.trim(), mode: value.mode,
        distanceKm: Number(value.distanceKm), distanceSource: value.distanceSource,
        factorSource, datasetId: value.datasetId, factorId: value.factorId,
        factorValue: factorSource === "manual" ? value.factorValue : null,
      },
      crypto.randomUUID(),
    );
    setPending(false);
    if (result.state !== "success") {
      notice({ kind: "warn", text: result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ") : result.message });
      return;
    }
    notice({ kind: "ok", text: `Leg ${value.fromLabel} → ${value.toLabel} added.` });
    onDone();
    router.refresh();
  }

  return (
    <div className="nz-acc-extra">
      <div className="nz-config-grid lca">
        <label className="nz-fl">From<input className="nz-inp" value={value.fromLabel} onChange={(e) => setValue({ ...value, fromLabel: e.target.value, distanceSource: "manual" })} placeholder="e.g. Ningbo plant, CN" /></label>
        <label className="nz-fl">To<input className="nz-inp" value={value.toLabel} onChange={(e) => setValue({ ...value, toLabel: e.target.value, distanceSource: "manual" })} placeholder="e.g. Felixstowe port, UK" /></label>
        <label className="nz-fl">Mode
          <select className="nz-sel" value={value.mode} onChange={(e) => setValue({ ...value, mode: e.target.value as LcaTransportLegWriteFields["mode"] })}>
            {Object.entries(TRANSPORT_MODE_LABEL).map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
          </select>
        </label>
        <label className="nz-fl">Distance (km)<input className="nz-inp" type="number" min="0" step="any" value={value.distanceKm} onChange={(e) => setValue({ ...value, distanceKm: Number(e.target.value), distanceSource: "manual" })} /></label>
      </div>
      <div className="nz-config-actions" style={{ justifyContent: "flex-start", marginTop: 8 }}>
        <button type="button" className="nz-btn" disabled={geocoding || !value.fromLabel.trim() || !value.toLabel.trim()} onClick={() => void geocode()}>{geocoding ? "Geocoding…" : "Estimate distance (geocode)"}</button>
        {value.distanceSource === "geocoded" && <span className="nz-hint">✓ geocoded — distance stays editable</span>}
      </div>

      <div className="nz-sect">Emission factor</div>
      <div className="nz-lca-modules">
        <label className="nz-lca-module-chip"><input type="radio" name="leg-factor-mode" checked={value.pickMode === "unmapped"} onChange={() => setValue({ ...value, pickMode: "unmapped" })} />Leave unmapped</label>
        <label className="nz-lca-module-chip"><input type="radio" name="leg-factor-mode" checked={value.pickMode === "search"} onChange={() => setValue({ ...value, pickMode: "search" })} />Search the factor library</label>
        <label className="nz-lca-module-chip"><input type="radio" name="leg-factor-mode" checked={value.pickMode === "manual"} onChange={() => setValue({ ...value, pickMode: "manual" })} />Enter a value manually</label>
      </div>
      {value.pickMode === "search" && (
        <div style={{ marginTop: 10 }}>
          <FactorPicker factors={factors} onPick={pickFactor} />
          {value.factorLabel && <div className="nz-hint">✓ {value.factorLabel}</div>}
        </div>
      )}
      {value.pickMode === "manual" && (
        <div className="nz-config-grid lca" style={{ marginTop: 10 }}>
          <label className="nz-fl">Factor value (kgCO₂e)<input className="nz-inp" type="number" step="any" value={value.factorValue ?? ""} onChange={(e) => setValue({ ...value, factorValue: e.target.value === "" ? null : Number(e.target.value) })} /></label>
        </div>
      )}

      <div className="nz-config-actions">
        <button type="button" className="nz-btn" onClick={onDone}>Cancel</button>
        <button type="button" className="nz-btn pri" disabled={pending || !value.fromLabel.trim() || !value.toLabel.trim()} onClick={() => void create()}>{pending ? "Adding…" : "Add leg"}</button>
      </div>
    </div>
  );
}

function ComponentPicker({ components, onPick }: { components: LcaComponentOption[]; onPick: (component: LcaComponentOption) => void }) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    if (!query.trim()) return [];
    return components
      .map((component) => ({ component, score: fuzzyScore(query, `${component.description} ${component.componentCode ?? ""} ${component.supplierName ?? ""} ${component.materialCategoryLabel ?? ""}`) }))
      .filter((entry): entry is { component: LcaComponentOption; score: number } => entry.score !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((entry) => entry.component);
  }, [components, query]);

  return (
    <div className="nz-fast-add-search">
      <label className="nz-fl" style={{ margin: 0 }}>
        Component library <span className="muted">· optional quick-pick, prefills the fields below</span>
        <input className="nz-inp" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search reusable components…" />
      </label>
      {query.trim() && (
        <ul className="nz-template-results">
          {results.length === 0 && <li className="nz-template-empty">No component matches "{query}".</li>}
          {results.map((component) => (
            <li key={component.id}>
              <button type="button" onClick={() => { onPick(component); setQuery(""); }}>
                <b>{component.description}</b>
                <span className="nz-template-meta">{component.componentCode ?? "No code"} · {component.defaultUnit}{component.originCountry ? ` · ${component.originCountry}` : ""}{component.clientId ? "" : " · global"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FactorPicker({ factors, onPick }: { factors: FactorOption[]; onPick: (factor: FactorOption) => void }) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    if (!query.trim()) return [];
    return factors
      .map((factor) => ({ factor, score: fuzzyScore(query, `${factor.label} ${factor.datasetName} ${factor.activityUnit}`) }))
      .filter((entry): entry is { factor: FactorOption; score: number } => entry.score !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((entry) => entry.factor);
  }, [factors, query]);

  return (
    <div className="nz-fast-add-search">
      <label className="nz-fl" style={{ margin: 0 }}>
        Factor library <span className="muted">· shared with the job's Scope rows</span>
        <input className="nz-inp" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search datasets and client factors…" />
      </label>
      {query.trim() && (
        <ul className="nz-template-results">
          {results.length === 0 && <li className="nz-template-empty">No factor matches "{query}".</li>}
          {results.map((factor) => (
            <li key={`${factor.factorSource}:${factor.clientFactorId ?? factor.datasetId}|${factor.factorId}`}>
              <button type="button" onClick={() => { onPick(factor); setQuery(""); }}>
                <b>{factor.label}</b>
                <span className="nz-template-meta">{factor.activityUnit} · {factor.datasetName}{factor.factorSource === "client" ? " · client factor" : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type PickMode = "unmapped" | "manual" | "search";
type LineItemDraft = {
  moduleCode: LcaModuleCode; lineLabel: string; componentId: string | null; materialCategoryId: string | null;
  quantity: number; unit: string; originCountry: string;
  pickMode: PickMode; datasetId: string | null; factorId: string | null; clientFactorId: string | null;
  factorValue: number | null; factorUnit: string; factorLabel: string | null; dataQuality: LcaDataQuality;
};

function NewLineItemForm({ jobId, assessment, factors, components, categories, onDone, notice }: {
  jobId: string; assessment: LcaAssessment; factors: FactorOption[]; components: LcaComponentOption[];
  categories: { id: string; name: string }[]; onDone: () => void; notice: (n: Notice) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [value, setValue] = useState<LineItemDraft>({
    moduleCode: assessment.includedModules[0] ?? "A1", lineLabel: "", componentId: null, materialCategoryId: null,
    quantity: 0, unit: "kg", originCountry: "",
    pickMode: "unmapped", datasetId: null, factorId: null, clientFactorId: null,
    factorValue: null, factorUnit: "", factorLabel: null, dataQuality: "estimated",
  });

  function pickComponent(component: LcaComponentOption) {
    setValue((current) => ({
      ...current,
      componentId: component.id,
      lineLabel: current.lineLabel.trim() || component.description,
      materialCategoryId: component.materialCategoryId ?? current.materialCategoryId,
      unit: component.defaultUnit || current.unit,
      quantity: component.defaultUnitMass ?? current.quantity,
      originCountry: component.originCountry ?? current.originCountry,
    }));
  }

  function pickFactor(factor: FactorOption) {
    setValue((current) => ({
      ...current,
      datasetId: factor.factorSource === "client" ? null : factor.datasetId,
      factorId: factor.factorSource === "client" ? null : factor.factorId,
      clientFactorId: factor.factorSource === "client" ? factor.clientFactorId : null,
      factorUnit: factor.activityUnit, factorLabel: factor.label,
    }));
  }

  function setPickMode(mode: PickMode) {
    setValue((current) => ({
      ...current, pickMode: mode,
      ...(mode === "unmapped" ? { datasetId: null, factorId: null, clientFactorId: null, factorValue: null, factorUnit: "", factorLabel: null } : {}),
      ...(mode === "manual" ? { datasetId: null, factorId: null, clientFactorId: null, factorLabel: null } : {}),
      ...(mode === "search" ? { factorValue: null } : {}),
    }));
  }

  async function create() {
    if (pending || !value.lineLabel.trim() || !value.unit.trim()) return;
    setPending(true);
    const factorSource = value.pickMode === "unmapped" ? "unmapped" : value.pickMode === "manual" ? "manual" : value.clientFactorId ? "client" : "dataset";
    const result = await postBrowserCommand<{ lineItemId: string }>(
      `/api/isolated/jobs/${jobId}/lca-assessments/${assessment.id}/line-items`,
      {
        componentId: value.componentId, moduleCode: value.moduleCode, lineLabel: value.lineLabel.trim(),
        materialCategoryId: value.materialCategoryId, quantity: Number(value.quantity), unit: value.unit.trim(),
        originCountry: value.originCountry.trim() || null,
        factorSource, datasetId: value.datasetId, factorId: value.factorId, clientFactorId: value.clientFactorId,
        factorValue: factorSource === "manual" ? value.factorValue : null,
        factorUnit: value.factorUnit.trim() || null, factorLabel: value.factorLabel,
        dataQuality: value.dataQuality,
      },
      crypto.randomUUID(),
    );
    setPending(false);
    if (result.state !== "success") {
      notice({ kind: "warn", text: result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ") : result.message });
      return;
    }
    notice({ kind: "ok", text: `${value.lineLabel} added to ${MODULE_LABEL[value.moduleCode]}.` });
    onDone();
    router.refresh();
  }

  return (
    <div className="nz-acc-extra">
      <ComponentPicker components={components} onPick={pickComponent} />
      <div className="nz-config-grid lca" style={{ marginTop: 12 }}>
        <label className="nz-fl">Module
          <select className="nz-sel" value={value.moduleCode} onChange={(e) => setValue({ ...value, moduleCode: e.target.value as LcaModuleCode })}>
            {assessment.includedModules.map((code) => <option key={code} value={code}>{MODULE_LABEL[code]}</option>)}
          </select>
        </label>
        <label className="nz-fl">Line label<input className="nz-inp" value={value.lineLabel} onChange={(e) => setValue({ ...value, lineLabel: e.target.value })} placeholder="e.g. rPET tray" /></label>
        <label className="nz-fl">Material category
          <select className="nz-sel" value={value.materialCategoryId ?? ""} onChange={(e) => setValue({ ...value, materialCategoryId: e.target.value || null })}>
            <option value="">Unspecified</option>
            {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
        </label>
        <label className="nz-fl">Quantity<input className="nz-inp" type="number" min="0" step="any" value={value.quantity} onChange={(e) => setValue({ ...value, quantity: Number(e.target.value) })} /></label>
        <label className="nz-fl">Unit<input className="nz-inp" value={value.unit} onChange={(e) => setValue({ ...value, unit: e.target.value })} /></label>
        <label className="nz-fl">Origin country<input className="nz-inp" value={value.originCountry} onChange={(e) => setValue({ ...value, originCountry: e.target.value })} placeholder="Optional" /></label>
        <label className="nz-fl">Data quality
          <select className="nz-sel" value={value.dataQuality} onChange={(e) => setValue({ ...value, dataQuality: e.target.value as LcaDataQuality })}>
            <option value="primary">Primary</option>
            <option value="secondary">Secondary</option>
            <option value="proxy">Proxy</option>
            <option value="estimated">Estimated</option>
          </select>
        </label>
      </div>

      <div className="nz-sect">Emission factor</div>
      <div className="nz-lca-modules">
        <label className="nz-lca-module-chip"><input type="radio" name="factor-mode" checked={value.pickMode === "unmapped"} onChange={() => setPickMode("unmapped")} />Leave unmapped</label>
        <label className="nz-lca-module-chip"><input type="radio" name="factor-mode" checked={value.pickMode === "search"} onChange={() => setPickMode("search")} />Search the factor library</label>
        <label className="nz-lca-module-chip"><input type="radio" name="factor-mode" checked={value.pickMode === "manual"} onChange={() => setPickMode("manual")} />Enter a value manually</label>
      </div>
      {value.pickMode === "search" && (
        <div style={{ marginTop: 10 }}>
          <FactorPicker factors={factors} onPick={pickFactor} />
          {value.factorLabel && <div className="nz-hint">✓ {value.factorLabel} ({value.factorUnit})</div>}
        </div>
      )}
      {value.pickMode === "manual" && (
        <div className="nz-config-grid lca" style={{ marginTop: 10 }}>
          <label className="nz-fl">Factor value (kgCO₂e per unit)<input className="nz-inp" type="number" step="any" value={value.factorValue ?? ""} onChange={(e) => setValue({ ...value, factorValue: e.target.value === "" ? null : Number(e.target.value) })} /></label>
          <label className="nz-fl">Factor unit<input className="nz-inp" value={value.factorUnit} onChange={(e) => setValue({ ...value, factorUnit: e.target.value })} placeholder="e.g. kg" /></label>
        </div>
      )}

      <div className="nz-config-actions">
        <button type="button" className="nz-btn" onClick={onDone}>Cancel</button>
        <button type="button" className="nz-btn pri" disabled={pending || !value.lineLabel.trim() || !value.unit.trim()} onClick={() => void create()}>
          {pending ? "Adding…" : "Add line item"}
        </button>
      </div>
    </div>
  );
}

type BomRow = { key: string; moduleCode: LcaModuleCode | null; lineLabel: string; quantity: number | null; unit: string; originCountry: string | null };

function BulkImportPanel({ jobId, assessment, onDone, notice }: { jobId: string; assessment: LcaAssessment; onDone: () => void; notice: (n: Notice) => void }) {
  const router = useRouter();
  const [raw, setRaw] = useState("");
  const [rows, setRows] = useState<BomRow[]>([]);
  const [busy, setBusy] = useState(false);

  function parse() {
    const parsed = parseLcaBomLines(raw).map((line) => ({ key: crypto.randomUUID(), ...line, moduleCode: line.moduleCode ?? assessment.includedModules[0] ?? "A1" }));
    setRows((current) => [...current, ...parsed]);
    setRaw("");
    notice(parsed.length
      ? { kind: "ok", text: `${parsed.length} line${parsed.length === 1 ? "" : "s"} parsed. Confirm the module for each, then import.` }
      : { kind: "warn", text: "No BOM rows were recognised. Expected module, label, quantity, unit." });
  }

  function downloadTemplate() {
    const blob = new Blob([lcaBomTemplateCsv()], { type: "text/csv;charset=utf-8" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = "lca-bom-template.csv";
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  const update = (key: string, patch: Partial<BomRow>) => setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const remove = (key: string) => setRows((current) => current.filter((row) => row.key !== key));
  const ready = (row: BomRow) => row.lineLabel.trim() !== "" && row.quantity !== null && row.quantity >= 0 && row.moduleCode !== null;
  const readyCount = rows.filter(ready).length;

  async function importRows() {
    if (busy) return;
    const toSave = rows.filter(ready);
    if (toSave.length === 0) { notice({ kind: "warn", text: "Add at least one line with a label, a module and a non-negative quantity." }); return; }
    setBusy(true);
    const result = await postBrowserCommand<{ lineItemIds: string[] }>(
      `/api/isolated/jobs/${jobId}/lca-assessments/${assessment.id}/line-items-bulk`,
      { lines: toSave.map((row) => ({ moduleCode: row.moduleCode, lineLabel: row.lineLabel.trim(), quantity: Number(row.quantity), unit: row.unit.trim() || "kg", originCountry: row.originCountry?.trim() || null })) },
      crypto.randomUUID(),
    );
    setBusy(false);
    if (result.state !== "success") {
      notice({ kind: "warn", text: result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ") : result.message });
      return;
    }
    notice({ kind: "ok", text: `${result.data.lineItemIds.length} line item${result.data.lineItemIds.length === 1 ? "" : "s"} imported. Map their factors next.` });
    setRows([]);
    onDone();
    router.refresh();
  }

  return (
    <div className="nz-acc-extra">
      {rows.length === 0 ? (
        <div className="nz-config-grid">
          <label className="nz-fl" style={{ gridColumn: "1/-1" }}>
            BOM rows <span className="muted">· module, label, quantity, unit, origin country</span>
            <textarea className="nz-notes" rows={6} value={raw} placeholder={"Module,Label,Quantity,Unit,Origin country\nA1,rPET tray,31.5,kg,GB"} onChange={(e) => setRaw(e.target.value)} />
          </label>
          <div className="nz-config-actions">
            <button type="button" className="nz-btn" onClick={onDone}>Cancel</button>
            <button type="button" className="nz-btn" onClick={downloadTemplate}>Download .csv template</button>
            <button type="button" className="nz-btn pri" disabled={!raw.trim()} onClick={parse}>Parse rows</button>
          </div>
        </div>
      ) : (
        <>
          <div className="nz-table-wrap">
            <table className="nz-tbl">
              <thead><tr><th>Module</th><th>Label</th><th className="num">Quantity</th><th>Unit</th><th>Origin</th><th /></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td>
                      <select className="nz-sel" aria-label={`Module for ${row.lineLabel || "row"}`} value={row.moduleCode ?? ""} onChange={(e) => update(row.key, { moduleCode: e.target.value as LcaModuleCode })}>
                        {assessment.includedModules.map((code) => <option key={code} value={code}>{code}</option>)}
                      </select>
                    </td>
                    <td><input className="nz-inp" aria-label="Label" value={row.lineLabel} onChange={(e) => update(row.key, { lineLabel: e.target.value })} /></td>
                    <td className="num"><input className="nz-inp" type="number" min="0" step="any" aria-label="Quantity" value={row.quantity ?? ""} onChange={(e) => update(row.key, { quantity: e.target.value === "" ? null : Number(e.target.value) })} /></td>
                    <td><input className="nz-inp" aria-label="Unit" value={row.unit} onChange={(e) => update(row.key, { unit: e.target.value })} /></td>
                    <td><input className="nz-inp" aria-label="Origin country" value={row.originCountry ?? ""} onChange={(e) => update(row.key, { originCountry: e.target.value })} /></td>
                    <td><button type="button" className="nz-btn" onClick={() => remove(row.key)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="nz-config-actions" style={{ marginTop: 12 }}>
            <button type="button" className="nz-btn" disabled={busy} onClick={() => { setRows([]); setRaw(""); }}>Clear</button>
            <button type="button" className="nz-btn pri" disabled={busy || readyCount === 0} onClick={() => void importRows()}>{busy ? "Importing…" : `Import ${readyCount} line${readyCount === 1 ? "" : "s"}`}</button>
          </div>
        </>
      )}
    </div>
  );
}
