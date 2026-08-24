"use client";

import { useMemo, useState } from "react";
import { AppShell, WorkspaceRail, TopBar, EvidenceDrawer } from "@nzi/ui";
import { type Job, type ScopeRow, type RowStatus, statusClass, statusLabel } from "@nzi/mock-data";
import { NAV, USER } from "../lib/nav";

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

export function JobBoard({ job }: { job: Job }) {
  const [selectedId, setSelectedId] = useState<string>("fgas");
  const [filter, setFilter] = useState<Filter>("all");

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
            <button className="nz-btn">Reopen</button>
            <button className="nz-btn pri">Mark reviewed</button>
          </>
        ) : (
          <>
            <button className="nz-btn">Flag</button>
            <button className="nz-btn pri">Save &amp; validate</button>
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

  return (
    <AppShell rail={rail} drawer={drawer}>
      <TopBar
        searchPlaceholder="Search sources, factors…"
        crumbs={
          <>
            Clients <span className="muted">/</span> <b>{job.client}</b>{" "}
            <span className="muted">/</span> Jobs <span className="muted">/</span> Job {job.number}
          </>
        }
      />

      <div className="nz-head">
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div>
            <h1>Job {job.number} — {job.year} carbon footprint</h1>
            <div className="sub">{job.client} · reporting year {job.year} · GHG Protocol · owner: {job.owner}</div>
          </div>
          <span className="nz-status" style={{ marginLeft: "auto" }}>
            <span className="d" />{job.statusLabel}
          </span>
        </div>
      </div>

      <div className="nz-stepper">
        <div className="nz-step done"><span className="n">✓</span><span className="lb">Scope defined</span><span className="bar" /></div>
        <div className="nz-step active"><span className="n">2</span><span className="lb">Data entry</span><span className="bar" /></div>
        <div className="nz-step todo"><span className="n">3</span><span className="lb">Factor mapping</span><span className="bar" /></div>
        <div className="nz-step todo"><span className="n">4</span><span className="lb">Review &amp; QA</span><span className="bar" /></div>
        <div className="nz-step todo"><span className="n">5</span><span className="lb">Report</span></div>
      </div>

      <div className="nz-toolbar">
        <div className="nz-filters">
          {filters.map((f) => (
            <button key={f.id} className={filter === f.id ? "on" : undefined} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="nz-prog">
          <span>{job.progressLabel} · <b style={{ color: "var(--t1)" }}>{job.progressPct}%</b></span>
          <div className="track"><div className="fill" style={{ width: `${job.progressPct}%` }} /></div>
          <button className="nz-btn">Import data</button>
          <button className="nz-btn pri">Run QA checks</button>
        </div>
      </div>

      <div className="nz-body">
        <div className="nz-panel">
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
      </div>
    </AppShell>
  );
}
