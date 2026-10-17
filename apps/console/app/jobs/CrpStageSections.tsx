"use client";
// UX1e-1 — stage-as-section layout for the CRP job workspace (NZC-038; the
// crp_v3 prototype). Behind the `job-stage-sections` flag. The active workflow
// stage is expanded; prior stages collapse to a one-line summary, later stages
// to a to-do card. Each stage owns its panels — Data Entry owns only the
// accordion. This is the reusable module shell the job-family modules (NZC-024)
// replicate.
import type { ReactNode } from "react";

export type StageStatus = "done" | "active" | "todo";

const badge = (status: StageStatus, n?: number) => (status === "done" ? "✓" : n === undefined ? "" : String(n));

/** The page element a stage jumps to — the section's own id, so the stepper, the focus strip and the sections agree. */
export const stageAnchorId = (name: string) => `stage-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

/**
 * DESIGN-job-data-entry-usability A/B: the job's 1–4 workflow stepper, persistent at the top of the job page and the
 * page's own navigation — each stage jumps to its place. State-driven from the recorded workflow stage, the same
 * reading as the Setup drawer's stepper: done = coloured and ticked, current = highlighted, to do = muted. The
 * stepper owns the numbering, so the sections below it carry none.
 */
export function JobStageStepper({ stages, status, onJump }: {
  stages: readonly string[];
  status: (index: number) => StageStatus;
  onJump: (name: string) => void;
}) {
  return (
    <nav className="nz-job-stepper" aria-label="Job stages">
      <ol className="nz-stepper">
        {stages.map((stage, index) => {
          const state = status(index);
          return (
            <li key={stage} className={`nz-step ${state}`} aria-current={state === "active" ? "step" : undefined}>
              <button type="button" onClick={() => onJump(stage)} aria-label={`${stage} — ${state === "done" ? "complete" : state === "active" ? "current stage" : "to do"}`}>
                <span className="n">{state === "done" ? "✓" : index + 1}</span>
                <span className="lb">{stage}</span>
              </button>
              {index < stages.length - 1 ? <span className="bar" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** One collapsible workflow stage. Controlled open state so the focus strip can jump to a stage. */
export function StageSection({
  n,
  name,
  status,
  summary,
  open,
  onToggle,
  children,
}: {
  /** The stage's number, where the sections are the page's only stepper; omitted under the job stepper, which numbers them. */
  n?: number;
  name: string;
  status: StageStatus;
  /** One-line summary shown in the collapsed header (prior/later stages). */
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const id = stageAnchorId(name);
  return (
    <section className={`nz-stage-sec ${status}${open ? " open" : ""}${n === undefined ? " unnumbered" : ""}`} id={id}>
      <button
        type="button"
        className="nz-stage-sec-h"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={onToggle}
      >
        <span className="nz-stage-sec-n">{badge(status, n)}</span>
        <span className="nz-stage-sec-tt">
          <b>
            {n === undefined ? name : `${n} · ${name}`}
            <span className={`nz-st ${status === "done" ? "done" : status === "active" ? "est" : "nof"}`}>
              {status === "done" ? "Complete" : status === "active" ? "Active" : "To do"}
            </span>
          </b>
          <span className="sum">{summary}</span>
        </span>
        <svg className="nz-stage-sec-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open ? (
        <div className="nz-stage-sec-body" id={`${id}-body`}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

/** Compact replacement for the command hero — readiness + next action + exception jumps. */
export function StageFocusStrip({
  readinessPercent,
  nextAction,
  exceptions,
}: {
  readinessPercent: number;
  nextAction: string;
  exceptions: Array<{ label: string; count: number; onOpen: () => void }>;
}) {
  return (
    <div className="nz-focus-strip">
      <div className="nz-focus-strip-lead">
        <span className={`nz-readiness-pill ${readinessPercent === 100 ? "ready" : ""}`}>
          <i />
          {readinessPercent}% ready
        </span>
        <span className="next">
          <span className="lab">Next</span>
          {nextAction}
        </span>
      </div>
      <div className="nz-focus-strip-jumps">
        {exceptions.map(exception => (
          <button type="button" key={exception.label} onClick={exception.onOpen}>
            <b>{exception.count}</b> {exception.label}
          </button>
        ))}
      </div>
    </div>
  );
}
