"use client";

/**
 * Client portal · training — READ-ONLY.
 *
 * The employer's view of their people's training and the places they hold. Three jobs, in
 * the order that matters to them: what they have still to use (unused places are money on
 * the table), what their team has done, and who holds what.
 *
 * The vocabulary is deliberately the client's, not the staff register's. Where the console
 * says "Lapsed · 2 unused", this says "Expired 31/03/2026 · 2 places went unused" — same
 * arithmetic from `trainingPlaceGroups`, different words, so the two can never quote
 * different numbers while still speaking to different readers.
 *
 * Nothing here books, records or issues anything: places are booked with the NZI
 * consultant, and a certificate belongs to the person, not to their employer.
 */

import { useCallback, useEffect, useState } from "react";
import { NziIcon } from "@nzi/ui";
import { trainingExpiryWarningDays } from "@nzi/contracts";
import type { PortalTrainingReadModel, PortalTrainingRecord } from "@nzi/isolated-backend";
import { formatDate } from "../../lib/formatDate";
import { redirectIfPortalSessionEnded } from "../portalSessionClient";

type State =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; model: PortalTrainingReadModel };

export function PortalTraining() {
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const response = await fetch("/api/portal/training", { cache: "no-store" });
      if (await redirectIfPortalSessionEnded(response)) return;
      if (!response.ok) { setState({ kind: "failed", message: "Your training records could not be loaded." }); return; }
      setState({ kind: "ready", model: await response.json() as PortalTrainingReadModel });
    } catch (cause) {
      setState({ kind: "failed", message: cause instanceof Error ? cause.message : "Your training records could not be loaded." });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (state.kind === "loading") {
    return <div className="nz-portal-state loading" role="status"><i>↻</i><div>
      <b>Loading your training records</b>
      <span>Reading the places you hold and the training your team has completed…</span>
    </div></div>;
  }
  if (state.kind === "failed") {
    return <div className="nz-portal-state failed" role="alert"><i>!</i><div>
      <b>Your training records are temporarily unavailable</b>
      <span>{state.message} Nothing has been estimated or filled in — no record is shown until it can be read from your confirmed training register.</span>
      <button className="nz-btn" onClick={() => void load()}>Try again</button>
    </div></div>;
  }

  return <PortalTrainingView model={state.model} />;
}

function PortalTrainingView({ model }: { model: PortalTrainingReadModel }) {
  const { places, records, skills } = model;
  // The headline is the sum of the rows below it, so the two can never disagree.
  const totals = places.reduce((sum, group) => ({
    granted: sum.granted + group.summary.granted,
    used: sum.used + group.summary.consumed + group.summary.reserved,
    available: sum.available + group.summary.available,
    expiringSoon: sum.expiringSoon + group.summary.expiringSoon,
  }), { granted: 0, used: 0, available: 0, expiringSoon: 0 });

  if (places.length === 0 && records.length === 0) {
    return <div className="nz-portal-state" role="status"><i>◈</i><div>
      <b>Your training records will appear here</b>
      <span>
        Once your team has trained with NZI — or your engagement includes training places — this page shows
        what you hold, what has been completed and who holds which certificate. Nothing is shown from work
        still in progress.
      </span>
    </div></div>;
  }

  return <>
    {places.length > 0 ? <>
      <h2 className="nz-pt-section"><NziIcon name="ticket" size={15} /> Your training places</h2>
      <div className="nz-pt-summary">
        <Stat value={totals.granted} label="Places granted" />
        <Stat value={totals.used} label="Used or booked" />
        <Stat value={totals.available} label="Yet to be taken" tone={totals.available > 0 ? "good" : undefined} />
        <Stat value={totals.expiringSoon} label={`Expiring within ${trainingExpiryWarningDays} days`} tone={totals.expiringSoon > 0 ? "warn" : undefined} />
      </div>

      <div className="nz-pt-places">
        {places.map((group) => {
          const expiry = group.expiry;
          const attention = expiry.state === "expiring" && group.summary.available > 0;
          return <div className={`nz-ent${attention ? " attn" : ""}`} key={group.key}>
            <span className="nz-ent-icon"><NziIcon name="ticket" size={18} /></span>
            <div className="nz-ent-main">
              <div className="nm">{group.courseLabel || "Training places"}</div>
              <div className="sub">From your {group.sourceJobNumber} engagement · {group.summary.granted} place{group.summary.granted === 1 ? "" : "s"}</div>
              <div className="nz-places">
                {group.places.map((state, index) => <i key={index}
                  className={`nz-dot${state === "consumed" ? " used" : state === "reserved" ? " resv" : state === "lapsed" ? " lapsed" : ""}`} />)}
              </div>
              {/* The client's words for the same fact the staff register states as mechanism. */}
              <div className="nz-pt-expiry">
                {expiry.state === "lapsed"
                  ? <span className="nz-expiry lapsed"><NziIcon name="alert" size={13} /> Expired {formatDate(expiry.expiresAt)}
                    {group.unusedAtExpiry > 0 ? ` · ${group.unusedAtExpiry} place${group.unusedAtExpiry === 1 ? "" : "s"} went unused` : ""}</span>
                  : expiry.state === "expiring"
                    ? <span className="nz-expiry warn"><NziIcon name="alert" size={13} /> Expires {formatDate(expiry.expiresAt)}
                      {group.summary.available > 0 ? ` · ${group.summary.available} still to book` : ""}</span>
                    : expiry.state === "active"
                      ? <span className="nz-expiry ok"><NziIcon name="calendar" size={13} /> Expires {formatDate(expiry.expiresAt)}</span>
                      : <span className="hint">No expiry date</span>}
              </div>
            </div>
            <div className="nz-ent-rem">
              <div className={group.summary.available > 0 ? "v num good" : "v num"}>{group.summary.available}</div>
              <div className="l">available</div>
            </div>
          </div>;
        })}
        <div className="nz-place-legend">
          <span className="hint"><i className="nz-dot used" /> Used</span>
          <span className="hint"><i className="nz-dot resv" /> Booked, not yet delivered</span>
          <span className="hint"><i className="nz-dot" /> Available to book</span>
          <span className="hint"><i className="nz-dot lapsed" /> Expired unused</span>
        </div>
      </div>
      <p className="hint nz-pt-note">Places are booked with your NZI consultant — talk to them and they will put your people on the next run.</p>
    </> : null}

    <h2 className="nz-pt-section"><NziIcon name="award" size={15} /> Training your team has taken</h2>
    {records.length === 0
      ? <div className="nz-panel"><div className="nz-card-b"><p className="sub">
        Nothing has been confirmed yet. A course appears here once your NZI team has confirmed its
        attendance register — never while it is still being finalised.
      </p></div></div>
      : <div className="nz-panel">
        <table className="nz-tbl">
          <thead><tr><th>Person</th><th>Course</th><th>Completed</th><th>Attendance</th><th>Certificate</th></tr></thead>
          <tbody>{records.map((record) => <tr key={record.bookingId}>
            <td><b>{record.personName}</b></td>
            <td>{record.courseLabel}</td>
            <td>{record.completedOn === null ? <span className="muted">—</span> : formatDate(record.completedOn)}</td>
            <td><span className="nz-att"><i><span style={{ width: `${record.attendancePct}%` }} /></i><b className="num">{record.attendancePct}%</b></span></td>
            <td><CertificateCell record={record} /></td>
          </tr>)}</tbody>
        </table>
        <div className="nz-card-b nz-pt-foot">
          <span className="nz-pt-assured">✓ From your confirmed training register</span>
          <span className="hint">
            Your own staff only. Each person keeps their full training history — including anything taken
            with a previous employer — in their own trainee account.
          </span>
        </div>
      </div>}

    {skills.courses.length > 0 ? <>
      <h2 className="nz-pt-section"><NziIcon name="check" size={15} /> Skills at a glance</h2>
      <div className="nz-panel">
        <table className="nz-tbl nz-pt-matrix">
          <thead><tr><th scope="col">Person</th>{skills.courses.map((course) => <th key={course} scope="col">{course}</th>)}</tr></thead>
          <tbody>{skills.people.map((person) => <tr key={person}>
            <th scope="row">{person}</th>
            {skills.courses.map((course) => {
              const cell = skills.cells[person]?.[course] ?? "none";
              return <td key={course}>
                {cell === "current"
                  ? <span className="nz-chk" title="Holds this training"><NziIcon name="check" size={12} /><span className="nz-sr-only">Holds this training</span></span>
                  : cell === "refresher-due"
                    ? <span className="nz-chk due" title="Refresher due"><NziIcon name="alert" size={12} /><span className="nz-sr-only">Refresher due</span></span>
                    : <span className="nz-chk none" aria-label="Not yet trained">·</span>}
              </td>;
            })}
          </tr>)}</tbody>
        </table>
        <div className="nz-card-b nz-pt-foot">
          <span className="hint"><span className="nz-chk"><NziIcon name="check" size={12} /></span> Holds this training</span>
          <span className="hint"><span className="nz-chk due"><NziIcon name="alert" size={12} /></span> Refresher due</span>
          <span className="hint"><span className="nz-chk none">·</span> Not yet trained</span>
          {/* Said once, plainly: a course only shows a refresher where one was actually agreed. */}
          <span className="hint">A refresher is only shown for courses that carry a renewal period.</span>
        </div>
      </div>
    </> : null}
  </>;
}

function CertificateCell({ record }: { record: PortalTrainingRecord }) {
  const { certificate } = record;
  if (certificate.state === "issued") {
    return <a className="nz-pt-cert" href={`/verify/${encodeURIComponent(certificate.verifyCode)}`}>
      <NziIcon name="award" size={13} /> Certificate
      {certificate.validUntil !== null ? <small> · valid to {formatDate(certificate.validUntil)}</small> : null}
    </a>;
  }
  return <span className={certificate.state === "pending" ? "up" : "muted"} title={certificate.reason}>
    {certificate.state === "pending" ? "Being issued" : "Below threshold"}
  </span>;
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: "good" | "warn" }) {
  return <div className={tone ? `nz-pt-stat ${tone}` : "nz-pt-stat"}>
    <div className="v num">{value}</div><div className="l">{label}</div>
  </div>;
}
