"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  patchBrowserCommand,
  postBrowserCommand,
  postBrowserCommandWithReason,
  putBrowserCommand,
} from "@nzi/api-client";
import type {
  DatasetOption,
  EmissionsTargetReadModel,
  FactorOption,
  SiteOption,
  ScopeQaReadiness,
  ScopeQualityTier,
  ScopeRowReadModel,
  ScopeRowWriteFields,
} from "@nzi/contracts";
import type { FamilyJob } from "@nzi/mock-data";
import { AppShell, EvidenceDrawer, TopBar, WorkspaceRail } from "@nzi/ui";
import { NAV, USER } from "../lib/nav";
import { WorkflowStageControl } from "./WorkflowStageControl";

const blank = (): ScopeRowWriteFields => ({
  scope: "1",
  sourceLabel: "",
  siteId:null,
  siteLabel:null,
  quantity: null,
  unit: null,
  datasetId: null,
  factorId: null,
  factorVersion: null,
  factorLabel: null,
  qualityTier: null,
});
const qualities: Array<{ value: ScopeQualityTier; label: string }> = [
  { value: "measured", label: "Measured" },
  { value: "estimated", label: "Estimated" },
  { value: "spend-based", label: "Spend-based" },
  { value: "survey", label: "Survey" },
];
const inputOf = (r: ScopeRowReadModel): ScopeRowWriteFields => ({
  scope: r.scope,
  sourceLabel: r.sourceLabel,
  siteId:r.siteId,
  siteLabel:r.siteLabel,
  quantity: r.quantity,
  unit: r.unit,
  datasetId: r.datasetId,
  factorId: r.factorId,
  factorVersion: r.factorVersion,
  factorLabel: r.factorLabel,
  qualityTier: r.qualityTier,
});
const errorText = (r: {
  state: string;
  message?: string;
  issues?: Array<{ message: string }>;
}) =>
  r.state === "validation_failed"
    ? (r.issues?.[0]?.message ?? r.message ?? "Validation failed.")
    : (r.message ?? "Command failed.");

export function CrpScopeWorkspace({
  job,
  rows,
  qa,
  factors,
  datasets,
  target,
  sites,
}: {
  job: FamilyJob;
  rows: ScopeRowReadModel[];
  qa: ScopeQaReadiness;
  factors: FactorOption[];
  datasets: DatasetOption[];
  target: EmissionsTargetReadModel | null;
  sites:SiteOption[];
}) {
  const qaNotice: { kind: "ok" | "warn"; text: string } = qa.readyForReporting
    ? {
        kind: "ok",
        text: `QA ready: all ${qa.enabled} enabled rows have complete calculations, quality tiers and independent approval.`,
      }
    : {
        kind: "warn",
        text: `QA pending: ${qa.calculationMissing} calculations missing · ${qa.qualityMissing} quality tiers missing · ${qa.independentReviewPending} rows awaiting independent approval.`,
      };
  const router = useRouter(),
    [selectedId, setSelectedId] = useState(rows[0]?.id ?? ""),
    [creating, setCreating] = useState(rows.length === 0),
    [draft, setDraft] = useState(blank()),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState<{
      kind: "ok" | "warn";
      text: string;
    } | null>(qaNotice);
  const selected = rows.find((r) => r.id === selectedId) ?? rows[0];
  async function create(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    const r = await postBrowserCommand<{ rowId: string }>(
      `/api/isolated/jobs/${job.header.id}/scope-rows`,
      draft,
      crypto.randomUUID(),
    );
    setPending(false);
    if (r.state === "success") {
      setSelectedId(r.data.rowId);
      setCreating(false);
      setDraft(blank());
      setNotice({ kind: "ok", text: "Scope row created." });
      router.refresh();
    } else setNotice({ kind: "warn", text: errorText(r) });
  }
  const drawer = selected ? (
    <EvidenceDrawer
      kicker={`Scope row · version ${selected.version}`}
      title={selected.sourceLabel}
      subtitle={`Scope ${selected.scope}`}
    >
      <Editor
        jobId={job.header.id}
        row={selected}
        factors={factors}
        sites={sites}
        notice={setNotice}
      />
      <div className="nz-sect">Calculation lineage</div>
      {selected.lineage.length ? (
        selected.lineage.map((x, i) => (
          <div className="nz-lin" key={i}>
            <div className="stepl">
              {x.title}
              <small>{x.detail}</small>
            </div>
          </div>
        ))
      ) : (
        <div className="muted">No calculation lineage yet.</div>
      )}
      <div className="nz-sect">Provenance</div>
      {Object.entries(selected.provenance).map(([k, v]) => (
        <div className="nz-kv" key={k}>
          <span className="k">{k}</span>
          <span className="v">{v === null ? "—" : String(v)}</span>
        </div>
      ))}
    </EvidenceDrawer>
  ) : undefined;
  return (
    <AppShell
      rail={<WorkspaceRail sections={NAV} activeId="jobs" user={USER} />}
      drawer={drawer}
    >
      <TopBar
        searchPlaceholder="Search sources, factors…"
        crumbs={
          <>
            Jobs / <b>{job.header.number}</b> / Scope rows
          </>
        }
      />
      <div className="nz-head">
        <h1>
          {job.header.number} — {job.header.title}
        </h1>
        <div className="sub">
          {job.header.client} · owner: {job.header.owner}
        </div>
        <button className="nz-btn pri" onClick={() => setCreating(!creating)}>
          {creating ? "Close" : "Add source"}
        </button>
      </div>
      <WorkflowStageControl job={job} />
      <div className="nz-body">
        {notice && (
          <div className={`nz-banner ${notice.kind}`}>{notice.text}</div>
        )}
        <TargetPanel jobId={job.header.id} reportingYear={job.header.reportingYear??new Date(job.header.startDate).getUTCFullYear()} target={target} notice={setNotice}/>
        <SitePanel jobId={job.header.id} sites={sites} notice={setNotice}/>
        <DatasetPanel
          jobId={job.header.id}
          datasets={datasets}
          notice={setNotice}
        />
        {creating && (
          <form
            className="nz-panel"
            style={{ padding: 16, marginBottom: 16 }}
            onSubmit={create}
          >
            <b>Add emissions source</b>
            <p className="sub">
              Factors are limited to datasets selected for this reporting
              period.
            </p>
            <Fields value={draft} change={setDraft} factors={factors} sites={sites}/>
            <button className="nz-btn pri" disabled={pending}>
              {pending ? "Creating…" : "Create scope row"}
            </button>
          </form>
        )}
        {rows.length === 0 ? (
          <div className="nz-panel" style={{ padding: 28 }}>
            No scope rows yet. Empty is not treated as zero.
          </div>
        ) : (
          <div className="nz-panel">
            <table className="nz-tbl">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Scope</th>
                  <th>Site</th>
                  <th>Activity</th>
                  <th>Unit</th>
                  <th>Factor</th>
                  <th>Quality</th>
                  <th>tCO₂e</th>
                  <th>Review</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className={`row${r.id === selected?.id ? " sel" : ""}`}
                    onClick={() => setSelectedId(r.id)}
                  >
                    <td>{r.sourceLabel}</td>
                    <td>{r.scope}</td>
                    <td>{r.siteLabel??"Unallocated"}</td>
                    <td>{r.quantity ?? "—"}</td>
                    <td>{r.unit ?? "—"}</td>
                    <td>{r.factorLabel ?? "No factor"}</td>
                    <td>
                      {qualities.find((q) => q.value === r.qualityTier)
                        ?.label ?? "—"}
                    </td>
                    <td>{r.overrideTco2e ?? r.calculatedTco2e ?? "—"}</td>
                    <td>{r.reviewStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function TargetPanel({jobId,reportingYear,target,notice}:{jobId:string;reportingYear:number;target:EmissionsTargetReadModel|null;notice:(n:{kind:"ok"|"warn";text:string})=>void}){
 const router=useRouter(),[value,setValue]=useState({baselineYear:target?.baselineYear??reportingYear,baselineTco2e:target?.baselineTco2e??0,interimYear:target?.interimYear??2030,interimReductionPercent:target?.interimReductionPercent??50,netZeroYear:target?.netZeroYear??2050}),[pending,setPending]=useState(false);
 async function save(){setPending(true);const result=await putBrowserCommand<{version:number}>(`/api/isolated/jobs/${jobId}/emissions-target`,{...value,expectedVersion:target?.version??0},crypto.randomUUID());setPending(false);if(result.state==="success"){notice({kind:"ok",text:`Emissions target v${result.data.version} saved. It will be frozen into the next reviewed snapshot.`});router.refresh();}else notice({kind:"warn",text:errorText(result)});}
 const field=(label:string,key:keyof typeof value,step="1")=><label className="nz-fl">{label}<input className="nz-inp" type="number" step={step} value={value[key]} onChange={e=>setValue({...value,[key]:Number(e.target.value)})}/></label>;
 return <div className="nz-panel" style={{padding:16,marginBottom:16}}><div style={{display:"flex",justifyContent:"space-between",gap:16,alignItems:"end"}}><div><b>Reduction pathway target</b><div className="sub">Baseline, interim reduction and net-zero milestone used by the shared report chart.</div></div><span className={`nz-st ${target?"done":""}`}>{target?`Version ${target.version}`:"Not configured"}</span></div><div style={{display:"grid",gridTemplateColumns:"repeat(5,minmax(120px,1fr))",gap:10,marginTop:12}}>{field("Baseline year","baselineYear")}{field("Baseline tCO₂e","baselineTco2e","any")}{field("Interim year","interimYear")}{field("Interim reduction %","interimReductionPercent","any")}{field("Net-zero year","netZeroYear")}</div><div style={{display:"flex",justifyContent:"flex-end",marginTop:12}}><button className="nz-btn pri" disabled={pending} onClick={save}>{pending?"Saving…":"Save target"}</button></div></div>;
}

function SitePanel({jobId,sites,notice}:{jobId:string;sites:SiteOption[];notice:(n:{kind:"ok"|"warn";text:string})=>void}){const router=useRouter(),[name,setName]=useState(""),[pending,setPending]=useState(false);async function add(){setPending(true);const result=await postBrowserCommand<{siteId:string;name:string}>(`/api/isolated/jobs/${jobId}/sites`,{name},crypto.randomUUID());setPending(false);if(result.state==="success"){setName("");notice({kind:"ok",text:`Site ${result.data.name} added.`});router.refresh();}else notice({kind:"warn",text:errorText(result)});}return <div className="nz-panel" style={{padding:16,marginBottom:16}}><b>Client sites</b><div className="sub">Assign emissions rows to a controlled site list. Unassigned emissions remain visible as Unallocated.</div><div style={{display:"flex",gap:10,marginTop:12}}><input className="nz-inp" value={name} onChange={e=>setName(e.target.value)} placeholder="New site name"/><button className="nz-btn" disabled={pending||!name.trim()} onClick={add}>Add site</button><span className="nz-st done">{sites.length} sites</span></div></div>}

function DatasetPanel({
  jobId,
  datasets,
  notice,
}: {
  jobId: string;
  datasets: DatasetOption[];
  notice: (n: { kind: "ok" | "warn"; text: string }) => void;
}) {
  const router = useRouter(),
    available = datasets.filter((d) => !d.selected),
    [datasetId, setDatasetId] = useState(available[0]?.datasetId ?? ""),
    [reason, setReason] = useState(""),
    [pending, setPending] = useState(false),
    selected = available.find((d) => d.datasetId === datasetId);
  async function add() {
    if (!selected) return;
    setPending(true);
    const r = await postBrowserCommandWithReason<{ warnings: string[] }>(
      `/api/isolated/jobs/${jobId}/datasets/manual`,
      {
        scope: "all",
        datasetId: selected.datasetId,
        reportingFrom: selected.reportingFrom,
        reportingTo: selected.reportingTo,
      },
      crypto.randomUUID(),
      reason,
    );
    setPending(false);
    if (r.state === "success") {
      notice({
        kind: r.data.warnings.length ? "warn" : "ok",
        text: r.data.warnings.length
          ? `Dataset added with exceptions: ${r.data.warnings.join(" ")}`
          : "Dataset manually added with an audited justification.",
      });
      router.refresh();
    } else notice({ kind: "warn", text: errorText(r) });
  }
  return (
    <div className="nz-panel" style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <div>
          <b>Reporting datasets</b>
          <div className="sub">
            {datasets.filter((d) => d.selected).length} selected automatically
            or by approved exception.
          </div>
        </div>
        {datasets[0] && (
          <span className="nz-st done">
            {datasets[0].reportingFrom} → {datasets[0].reportingTo} ·{" "}
            {datasets[0].jobCountryCode}
          </span>
        )}
      </div>
      {available.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 2fr auto",
            gap: 10,
            marginTop: 12,
          }}
        >
          <select
            className="nz-sel"
            value={datasetId}
            onChange={(e) => setDatasetId(e.target.value)}
          >
            {available.map((d) => (
              <option key={d.datasetId} value={d.datasetId}>
                {d.name} · {d.version} · {d.countryCode}
              </option>
            ))}
          </select>
          <input
            className="nz-inp"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Required justification for manual addition"
          />
          <button
            className="nz-btn"
            disabled={pending || !reason.trim()}
            onClick={add}
          >
            Add dataset
          </button>
        </div>
      )}
      {selected?.warnings.length ? (
        <div className="nz-banner warn" style={{ marginTop: 10 }}>
          {selected.warnings.join(" ")} Adding it will retain these warnings for
          review.
        </div>
      ) : null}
    </div>
  );
}

function Fields({
  value,
  change,
  factors,
  sites,
}: {
  value: ScopeRowWriteFields;
  change: (v: ScopeRowWriteFields) => void;
  factors: FactorOption[];
  sites:SiteOption[];
}) {
  const available = factors.filter((f) =>
      f.scopes.includes(value.scope.split(".")[0]!),
    ),
    selected =
      value.datasetId && value.factorId
        ? `${value.datasetId}|${value.factorId}`
        : "";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3,minmax(150px,1fr))",
        gap: 12,
        marginBottom: 14,
      }}
    >
      <label className="nz-fl">
        Source
        <input
          className="nz-inp"
          required
          value={value.sourceLabel}
          onChange={(e) => change({ ...value, sourceLabel: e.target.value })}
        />
      </label>
      <label className="nz-fl">
        Scope
        <input
          className="nz-inp"
          required
          value={value.scope}
          onChange={(e) => change({ ...value, scope: e.target.value })}
        />
      </label>
      <label className="nz-fl">
        Quality
        <select
          className="nz-sel"
          value={value.qualityTier ?? ""}
          onChange={(e) =>
            change({
              ...value,
              qualityTier: (e.target.value as ScopeQualityTier) || null,
            })
          }
        >
          <option value="">Not set</option>
          {qualities.map((q) => (
            <option key={q.value} value={q.value}>
              {q.label}
            </option>
          ))}
        </select>
      </label>
      <label className="nz-fl">Site<select className="nz-sel" value={value.siteId??""} onChange={e=>{const site=sites.find(item=>item.id===e.target.value);change({...value,siteId:site?.id??null,siteLabel:site?.name??null});}}><option value="">Unallocated</option>{sites.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
      <label className="nz-fl">
        Quantity
        <input
          className="nz-inp"
          type="number"
          min="0"
          step="any"
          value={value.quantity ?? ""}
          onChange={(e) =>
            change({
              ...value,
              quantity: e.target.value === "" ? null : Number(e.target.value),
            })
          }
        />
      </label>
      <label className="nz-fl">
        Unit
        <input
          className="nz-inp"
          value={value.unit ?? ""}
          onChange={(e) => change({ ...value, unit: e.target.value || null })}
        />
      </label>
      <label className="nz-fl">
        Emission factor
        <select
          className="nz-sel"
          value={selected}
          onChange={(e) => {
            const f = available.find(
              (x) => `${x.datasetId}|${x.factorId}` === e.target.value,
            );
            change({
              ...value,
              datasetId: f?.datasetId ?? null,
              factorId: f?.factorId ?? null,
              factorLabel: f?.label ?? null,
              factorVersion: f?.datasetVersion ?? null,
              unit: f?.activityUnit ?? value.unit,
            });
          }}
        >
          <option value="">No factor</option>
          {available.map((f) => (
            <option
              key={`${f.datasetId}|${f.factorId}`}
              value={`${f.datasetId}|${f.factorId}`}
            >
              {f.label} · {f.activityUnit}
              {f.synthetic ? " · DEMO" : ""}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function Editor({
  jobId,
  row,
  factors,
  sites,
  notice,
}: {
  jobId: string;
  row: ScopeRowReadModel;
  factors: FactorOption[];
  sites:SiteOption[];
  notice: (n: { kind: "ok" | "warn"; text: string }) => void;
}) {
  const router = useRouter(),
    [value, setValue] = useState(inputOf(row)),
    [enabled, setEnabled] = useState(row.enabled),
    [pending, setPending] = useState(false),
    [reviewerNote, setReviewerNote] = useState(row.reviewerNote ?? "");
  async function save() {
    setPending(true);
    const r = await patchBrowserCommand<{ version: number }>(
      `/api/isolated/jobs/${jobId}/scope-rows/${row.id}`,
      { ...value, enabled, expectedVersion: row.version },
      crypto.randomUUID(),
    );
    setPending(false);
    if (r.state === "success") {
      notice({
        kind: "ok",
        text: "Saved; calculation and review reset pending.",
      });
      router.refresh();
    } else notice({ kind: "warn", text: errorText(r) });
  }
  async function calculate() {
    setPending(true);
    const r = await postBrowserCommand<{ calculatedTco2e: number }>(
      `/api/isolated/jobs/${jobId}/scope-rows/${row.id}/calculate`,
      { expectedVersion: row.version },
      crypto.randomUUID(),
    );
    setPending(false);
    if (r.state === "success") {
      notice({
        kind: "ok",
        text: `Calculated ${r.data.calculatedTco2e.toLocaleString("en-GB")} tCO₂e with recorded lineage.`,
      });
      router.refresh();
    } else notice({ kind: "warn", text: errorText(r) });
  }
  async function review(decision: "approved" | "rejected") {
    setPending(true);
    const r = await postBrowserCommand<{ decision: string; version: number }>(
      `/api/isolated/jobs/${jobId}/scope-rows/${row.id}/review`,
      { decision, expectedReviewVersion: row.version, reviewerNote },
      crypto.randomUUID(),
    );
    setPending(false);
    if (r.state === "success") {
      notice({
        kind: decision === "approved" ? "ok" : "warn",
        text: `Row ${decision} with immutable reviewer evidence.`,
      });
      router.refresh();
    } else notice({ kind: "warn", text: errorText(r) });
  }
  async function snapshot() {
    setPending(true);
    const r = await postBrowserCommand<{
      snapshotId: string;
      version: number;
      reused: boolean;
    }>(
      `/api/isolated/jobs/${jobId}/reviewed-snapshots`,
      {},
      crypto.randomUUID(),
    );
    setPending(false);
    if (r.state === "success") {
      notice({
        kind: "ok",
        text: r.data.reused
          ? `Reviewed snapshot v${r.data.version} is already current.`
          : `Immutable reviewed snapshot v${r.data.version} created.`,
      });
      router.refresh();
    } else notice({ kind: "warn", text: errorText(r) });
  }
  return (
    <>
      <div
        className={`nz-banner ${row.calculatedTco2e === null ? "warn" : "ok"}`}
      >
        {row.calculatedTco2e === null
          ? "Save changes, then calculate."
          : "Calculated evidence is available."}
      </div>
      <Fields value={value} change={setValue} factors={factors} sites={sites}/>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />{" "}
        Enabled
      </label>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          className="nz-btn"
          disabled={pending || row.calculatedTco2e !== null}
          onClick={calculate}
        >
          Calculate
        </button>
        <button className="nz-btn pri" disabled={pending} onClick={save}>
          Save and invalidate calculation
        </button>
      </div>
      <div className="nz-sect">Independent review</div>
      <div
        className={`nz-banner ${row.reviewStatus === "approved" ? "ok" : "warn"}`}
      >
        {row.reviewStatus === "approved"
          ? `Approved by ${row.reviewedBy} at ${row.reviewedAt}.`
          : row.reviewStatus === "rejected"
            ? `Rejected: ${row.reviewerNote}`
            : "Pending independent reviewer decision."}
      </div>
      <textarea
        className="nz-notes"
        style={{ width: "100%" }}
        value={reviewerNote}
        onChange={(e) => setReviewerNote(e.target.value)}
        placeholder="Reviewer note (required for rejection)"
      />
      <div
        style={{
          display: "flex",
          gap: 8,
          justifyContent: "flex-end",
          marginTop: 8,
        }}
      >
        <button
          className="nz-btn"
          disabled={pending || !reviewerNote.trim()}
          onClick={() => review("rejected")}
        >
          Reject
        </button>
        <button
          className="nz-btn pri"
          disabled={pending || row.calculatedTco2e === null || !row.qualityTier}
          onClick={() => review("approved")}
        >
          Approve row
        </button>
      </div>
      <div className="nz-sect">Reporting snapshot</div>
      <p className="muted" style={{ fontSize: 12 }}>
        Creates an immutable, content-addressed snapshot only when every enabled
        row passes QA.
      </p>
      <button className="nz-btn pri" disabled={pending} onClick={snapshot}>
        Create reviewed snapshot
      </button>
    </>
  );
}
