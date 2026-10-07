"use client";

import { useEffect, useState } from "react";
import type { JobTimeSummary } from "@nzi/contracts";
import type { FamilyJob } from "@nzi/mock-data";
import { formatDate } from "../lib/formatDate";
import { hoursLabel } from "../time/timePeriods";
import { JobClientMark } from "./JobClientMark";

/**
 * Phase 2 job shell (JOB-REDESIGN-phase2-kickoff §1), behind `job-shell`: the job's identity on one line, its setup as
 * read-only chips, and a row of drawer buttons each carrying a small summary — so the page below can open on data
 * capture. Every figure here is a read the page already holds, except Time's, which is the job's own time read; a read
 * that fails says so ("unavailable") rather than showing a nought.
 */
export type JobShellDrawer = "setup" | "milestones" | "time" | "sites" | "datasets";

export type JobShellSummary = {
  datasets: string;
  sites: string;
  intensity: string;
  milestones: string;
};

const DRAWERS: ReadonlyArray<{ id: JobShellDrawer; label: string }> = [
  { id: "setup", label: "Setup" },
  { id: "milestones", label: "Milestones" },
  { id: "time", label: "Time" },
  { id: "sites", label: "Sites" },
  { id: "datasets", label: "Datasets" },
];

/** The job's logged hours, from the same read as the Time panel: "14.5 h", "…" while loading, "unavailable" on failure. */
function useJobHours(jobId: string): string {
  const [hours, setHours] = useState("…");
  useEffect(() => {
    let live = true;
    fetch(`/api/isolated/jobs/${encodeURIComponent(jobId)}/time`, { cache: "no-store" })
      .then(async (response) => {
        if (!live) return;
        if (!response.ok) return setHours("unavailable");
        const { summary } = await response.json() as { summary: JobTimeSummary };
        setHours(`${hoursLabel(summary.totals.minutes)} h${summary.othersVisible ? "" : " (yours)"}`);
      })
      .catch(() => { if (live) setHours("unavailable"); });
    return () => { live = false; };
  }, [jobId]);
  return hours;
}

export function JobShellHeader({ header, summary, actions, onOpen }: {
  header: FamilyJob["header"];
  summary: JobShellSummary;
  actions: React.ReactNode;
  onOpen: (drawer: JobShellDrawer) => void;
}) {
  const hours = useJobHours(header.id);
  const period = header.reportingPeriod ? `${formatDate(header.reportingPeriod.from)} – ${formatDate(header.reportingPeriod.to)}` : "No reporting period";
  const buttonSummary: Record<JobShellDrawer, string> = {
    setup: header.workflowStage, milestones: summary.milestones, time: hours, sites: summary.sites, datasets: summary.datasets,
  };
  return <header className="nz-shell-head" aria-label="Job summary">
    <div className="nz-shell-identity">
      <div className="nz-job-client"><JobClientMark header={header} /><div>
        <h1>{header.number} — {header.title}</h1>
        <div className="sub nz-shell-meta">
          <span>{header.client}</span><span>{period}</span>
          <span className="nz-shell-stage">{header.workflowStage}</span>
          <span>Lead consultant: {header.owner}</span>
        </div>
      </div></div>
      <div className="nz-head-actions">{actions}</div>
    </div>
    <div className="nz-shell-chips" aria-label="Job setup">
      <button type="button" className="nz-shell-chip" onClick={() => onOpen("datasets")}><span>Datasets</span><b>{summary.datasets}</b></button>
      <button type="button" className="nz-shell-chip" onClick={() => onOpen("sites")}><span>Sites</span><b>{summary.sites}</b></button>
      <button type="button" className="nz-shell-chip" onClick={() => onOpen("setup")}><span>Intensity</span><b>{summary.intensity}</b></button>
    </div>
    <nav className="nz-shell-drawers" aria-label="Job details">
      {DRAWERS.map((drawer) => <button type="button" key={drawer.id} className="nz-shell-drawer-btn" onClick={() => onOpen(drawer.id)}>
        <b>{drawer.label}</b><span>{buttonSummary[drawer.id]}</span>
      </button>)}
    </nav>
  </header>;
}

/** "DESNZ GB 2025 +1" — the first selected dataset by its #419 label, and how many more. */
export function datasetsSummary(datasets: ReadonlyArray<{ selected: boolean; label: string }>): string {
  const selected = datasets.filter((dataset) => dataset.selected);
  if (selected.length === 0) return "None selected";
  return selected.length === 1 ? selected[0]!.label : `${selected[0]!.label} +${selected.length - 1}`;
}

/** "3 · next 12 Oct" — the job's milestones, and the next one still open; "Not set" when it has none. */
export function milestonesSummary(milestones: ReadonlyArray<{ dueDate: string | null; completedAt: string | null }> | null): string {
  if (milestones === null) return "unavailable";
  if (milestones.length === 0) return "Not set";
  const next = milestones.filter((m) => !m.completedAt && m.dueDate).map((m) => m.dueDate!).sort()[0];
  const open = milestones.filter((m) => !m.completedAt).length;
  return next ? `${milestones.length} · next ${formatDate(next)}` : open === 0 ? `${milestones.length} · all done` : `${milestones.length} · ${open} undated`;
}
