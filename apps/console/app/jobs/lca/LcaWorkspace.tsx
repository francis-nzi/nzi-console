"use client";

// Track C — LCA/PCF reference module, slice 1: the assessment register
// (NZC-052/054/055; docs/MODEL_FIDELITY_JOB_FAMILIES.md §2/§6/§7). Behind
// `job-module-lca`; FamilyWorkspace still serves lca/pcf jobs when the flag
// is off. This slice is the "Model Register" only — create/edit an
// assessment's header fields. Line items, factor mapping, transport legs,
// the calc engine, charts and the report manifest are later slices.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell, TopBar, WorkspaceRail } from "@nzi/ui";
import { jobFamilyMeta, type FamilyJob } from "@nzi/mock-data";
import { postBrowserCommand } from "@nzi/api-client";
import { lcaModuleCodes, type LcaAssessment, type LcaAssessmentType, type LcaLifecycleBoundary, type LcaModuleCode } from "@nzi/contracts";
import { NAV, USER } from "../../lib/nav";
import { WorkflowStageControl } from "../WorkflowStageControl";

type Notice = { kind: "ok" | "warn"; text: string };

const MODULE_LABEL: Record<LcaModuleCode, string> = {
  A1: "A1 · Raw material supply", A2: "A2 · Transport to manufacturer", A3: "A3 · Manufacturing",
  A4: "A4 · Transport to site/user", A5: "A5 · Construction/installation",
  B1: "B1 · Use", B2: "B2 · Maintenance", B3: "B3 · Repair", B4: "B4 · Replacement",
  B5: "B5 · Refurbishment", B6: "B6 · Operational energy", B7: "B7 · Operational water",
  C1: "C1 · Deconstruction", C2: "C2 · Transport to waste", C3: "C3 · Waste processing", C4: "C4 · Disposal",
  D: "D · Benefits beyond boundary",
};

export function LcaWorkspace({ job, assessments }: { job: FamilyJob; assessments: LcaAssessment[] }) {
  const { header } = job;
  const meta = jobFamilyMeta[header.family];
  const [notice, setNotice] = useState<Notice | null>(null);
  const [creating, setCreating] = useState(assessments.length === 0);

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
              <thead><tr><th>Name</th><th>Type</th><th>Functional unit</th><th>Boundary</th><th>Modules</th><th className="num">tCO₂e</th><th>Review</th></tr></thead>
              <tbody>
                {assessments.map((assessment) => (
                  <tr key={assessment.id}>
                    <td><b>{assessment.name}</b>{assessment.sku ? <div className="muted">SKU {assessment.sku}</div> : null}{assessment.isPcf ? <span className="nz-chip-mini todo" style={{ marginLeft: 6 }}>PCF</span> : null}</td>
                    <td>{assessment.assessmentType}</td>
                    <td>{assessment.functionalUnitValue} {assessment.functionalUnitUnit}</td>
                    <td>{assessment.lifecycleBoundary.replaceAll("_", " ")}</td>
                    <td>{assessment.includedModules.join(", ")}</td>
                    <td className="num">{assessment.totalTco2e.toLocaleString("en-GB", { maximumFractionDigits: 2 })}</td>
                    <td><span className={`nz-st ${assessment.reviewStatus === "approved" ? "done" : assessment.reviewStatus === "rejected" ? "nof" : "est"}`}>{assessment.reviewStatus}</span></td>
                  </tr>
                ))}
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
            <h2>Line items, factor mapping, transport legs, recalculation, module-breakdown chart and the report manifest</h2>
            <p>{meta.description}. This register is slice 1 of the reference module — the rest lands behind the same flag as it is built.</p>
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
