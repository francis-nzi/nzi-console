"use client";

import { useMemo, useState } from "react";
import { AppShell, WorkspaceRail, TopBar, EvidenceDrawer } from "@nzi/ui";
import { type FamilyJob, type Job, type ScopeRow, type RowStatus, statusClass, statusLabel } from "@nzi/mock-data";
import { NAV, USER } from "../lib/nav";
import { CrpWorkspacePanel, type CrpStage } from "./CrpWorkspacePanels";
import { WorkflowStageControl } from "./WorkflowStageControl";

type Filter = "all" | RowStatus;

function BannerIcon({ kind }: { kind: "ok" | "warn" }) {
  return (
    <svg viewBox="0 0 24 24">
      {kind === "ok" ? (
        <path d="M20 6L9 17l-5-5" />
      ) : (
        <>
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        </>
      )}
    </svg>
  );
}

function DrawerBody({ row }: { row: ScopeRow }) {
  const activityMissing = row.activity === null;
  return (
    <>
      <div className={`nz-banner ${row.banner.kind}`}>
        <BannerIcon kind={row.banner.kind} />
        <div>{row.banner.text}</div>
      </div>

      <div className="nz-fl">
        <label>
          Activity data{activityMissing && <span className="req">required</span>}
        </label>
        <div className="nz-inp2">
          <input
            className={`nz-inp${activityMissing ? " bad" : ""}`}
            defaultValue={row.activity ?? ""}
            placeholder="Enter value"
          />
          <select className="nz-sel" defaultValue={row.unit ?? ""}>
            <option value="">unit</option>
            {[row.unit, "kg", "litres", "kWh", "km", "t·km"].filter(Boolean).map((u) => (
              <option key={u as string}>{u}</option>
            ))}
          </select>
        </div>
        {activityMissing ? (
          <div className="nz-hint bad">Enter the measured or estimated quantity to include this line.</div>
        ) : (
          <div className="nz-hint">Editable · last saved by A. Shaw</div>
        )}
      </div>

      <div className="nz-fl">
        <label>Emission factor</label>
        <div className={`nz-factorbox${row.factorMatched ? " matched" : ""}`}>
          {row.factorText}&nbsp;
          <a href="#">{row.factorMatched ? "Change" : "Match factor →"}</a>
        </div>
      </div>

      <div className="nz-fl">
        <label>Data quality</label>
        <select className="nz-sel" style={{ width: "100%" }} defaultValue={row.quality}>
          {[row.quality, "Measured", "Estimated", "Spend-based", "Survey"]
            .filter((v, i, a) => a.indexOf(v) === i)
            .map((q) => (
              <option key={q}>{q}</option>
            ))}
        </select>
      </div>

      <div className="nz-kv"><span className="k">Factor set</span><span className="v">{row.factorSet}</span></div>
      <div className="nz-kv"><span className="k">Provenance</span><span className="v">{row.provenance}</span></div>
      <div className="nz-kv"><span className="k">Result</span><span className="v">{row.tco2e ?? "—"}</span></div>

      {row.lineage && (
        <>
          <div className="nz-sect">Calculation lineage</div>
          <div className="nz-lin">
            {row.lineage.map((s, i) => (
              <div className="stepl" key={i}>
                {s.title}
                <small>{s.detail}</small>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="nz-sect">Reviewer note</div>
      <textarea className="nz-notes" placeholder="Add a note for QA…" />
    </>
  );
}

export function JobBoard({ job, workflowJob }: { job: Job; workflowJob: FamilyJob }) {
  const [selectedId, setSelectedId] = useState<string>("fgas");
  const [filter, setFilter] = useState<Filter>("all");
  const [stage, setStage] = useState<CrpStage>("data");

  const rows = useMemo(
    () => (filter === "all" ? job.rows : job.rows.filter((r) => r.status === filter)),
    [job.rows, filter],
  );
  const selected = job.rows.find((r) => r.id === selectedId) ?? job.rows[0]!;

  const rail = <WorkspaceRail sections={NAV} activeId="jobs" user={USER} />;

  const drawer = (
    <EvidenceDrawer
      kicker={`Scope row · ${statusLabel[selected.status].toLowerCase()}`}
      title={selected.source}
      subtitle={`Scope ${selected.scope}`}
      actions={
        selected.status === "complete" ? (
          <>
            <button type="button" className="nz-btn">Reopen</button>
            <button type="button" className="nz-btn pri">Mark reviewed</button>
          </>
        ) : (
          <>
            <button type="button" className="nz-btn">Flag</button>
            <button type="button" className="nz-btn pri">Save &amp; validate</button>
          </>
        )
      }
    >
      <DrawerBody row={selected} />
    </EvidenceDrawer>
  );

  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: `All ${job.counts.all}` },
    { id: "needs", label: `Needs data ${job.counts.needs}` },
    { id: "estimated", label: `Estimated ${job.counts.estimated}` },
    { id: "complete", label: `Complete ${job.counts.complete}` },
  ];

  const showEvidence = stage === "data" || stage === "mapping" || stage === "review";
  const stages: Array<{ id: CrpStage; label: string }> = [
    { id: "scope", label: "Scope defined" },
    { id: "data", label: "Data entry" },
    { id: "mapping", label: "Factor mapping" },
    { id: "review", label: "Review & QA" },
    { id: "report", label: "Report & publish" },
  ];

  return (
    <AppShell rail={rail} drawer={showEvidence ? drawer : undefined}>
      <TopBar
        searchPlaceholder="Search sources, factors…"
        crumbs={
          <>
            Clients <span className="muted">/</span> <b>{job.client}</b>{" "}
            <span className="muted">/</span> Jobs <span className="muted">/</span> Job {job.number}
          </>
        }
      />

      <div className="nz-head nz-job-head">
        <div className="nz-job-heading">
          <div>
            <div className="nz-eyebrow">Carbon Reduction Plan</div>
            <h1>Job {job.number} — {job.year} carbon footprint</h1>
            <div className="sub">{job.client} · reporting year {job.year} · GHG Protocol · owner: {job.owner}</div>
          </div>
          <span className="nz-status">
            <span className="d" />{job.statusLabel}
          </span>
        </div>
      </div>

      <WorkflowStageControl job={workflowJob} />

      <nav className="nz-stepper nz-job-stepper" aria-label="CRP workflow stages">{stages.map((item, index) => {
        const activeIndex = stages.findIndex((candidate) => candidate.id === stage);
        return <button key={item.id} type="button" aria-current={item.id === stage ? "step" : undefined} className={`nz-step ${item.id === stage ? "active" : index < activeIndex ? "done" : "todo"}`} onClick={() => setStage(item.id)}><span className="n">{index < activeIndex ? "✓" : index + 1}</span><span className="lb">{item.label}</span>{index < stages.length - 1 && <span className="bar" />}</button>;
      })}</nav>

      {stage === "data" && <div className="nz-toolbar">
        <div className="nz-filters">
          {filters.map((f) => (
            <button key={f.id} className={filter === f.id ? "on" : undefined} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="nz-prog">
          <span>{job.progressLabel} · <b style={{ color: "var(--t1)" }}>{job.progressPct}%</b></span>
          <div className="track" role="progressbar" aria-label="Data completion" aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progressPct}><div className="fill" style={{ width: `${job.progressPct}%` }} /></div>
          <button type="button" className="nz-btn">Import data</button>
          <button type="button" className="nz-btn pri">Run QA checks</button>
        </div>
      </div>}

      {stage === "data" && <div className="nz-body">
        <div className="nz-panel nz-table-wrap">
          <table className="nz-tbl">
            <thead>
              <tr>
                <th>Source</th><th>Scope</th><th className="num">Activity</th><th>Unit</th>
                <th>Factor</th><th className="num">tCO₂e</th><th>Quality</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={`row${r.id === selectedId ? " sel" : ""}`}
                  onClick={() => setSelectedId(r.id)}
                  onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedId(r.id); } }}
                  tabIndex={0}
                  aria-selected={r.id === selectedId}
                >
                  <td>{r.source}</td>
                  <td>
                    <span className="nz-sc"><span className="nz-sq" style={{ background: r.scopeColor }} />{r.scope}</span>
                  </td>
                  <td className="num">{r.activity ?? <span className="muted">—</span>}</td>
                  <td>{r.unit ?? <span className="muted">—</span>}</td>
                  <td>{r.factorMatched ? r.factorSet.replace(/ · v.*/, "") : <span className="nz-st nof">No factor</span>}</td>
                  <td className="num">{r.tco2e ? r.tco2e.replace(" tCO₂e", "") : <span className="muted">—</span>}</td>
                  <td>{r.quality === "Not set" ? <span className="muted">—</span> : r.quality}</td>
                  <td><span className={`nz-st ${statusClass[r.status]}`}>{statusLabel[r.status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>}
      {stage !== "data" && <CrpWorkspacePanel stage={stage} job={job} />}
    </AppShell>
  );
}
