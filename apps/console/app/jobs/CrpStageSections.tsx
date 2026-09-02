"use client";
// UX1e-1 — stage-as-section layout for the CRP job workspace (NZC-038; the
// crp_v3 prototype). Behind the `job-stage-sections` flag. The active workflow
// stage is expanded; prior stages collapse to a one-line summary, later stages
// to a to-do card. Each stage owns its panels — Data Entry owns only the
// accordion. This is the reusable module shell the job-family modules (NZC-024)
// replicate.
import type { ReactNode } from "react";

export type StageStatus = "done" | "active" | "todo";

const badge = (status: StageStatus, n: number) => (status === "done" ? "✓" : String(n));

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
  n: number;
  name: string;
  status: StageStatus;
  /** One-line summary shown in the collapsed header (prior/later stages). */
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const id = `stage-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section className={`nz-stage-sec ${status}${open ? " open" : ""}`} id={id}>
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
            {n} · {name}
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
