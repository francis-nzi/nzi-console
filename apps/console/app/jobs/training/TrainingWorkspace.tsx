"use client";

import { useState } from "react";
import Link from "next/link";
import { AppShell, GatedButton, NziIcon, TopBar, WorkspaceRail } from "@nzi/ui";
import { patchBrowserCommand, postBrowserCommand, putBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import {
  trainingAttendanceForBooking, trainingCertificateDecision, trainingPlaceGroups,
  trainingRunStageLabels, trainingRunStages, trainingRunSummary,
  type TrainingRunStage,
} from "@nzi/contracts";
import { jobFamilyMeta, type FamilyJob } from "@nzi/mock-data";
import type { TrainingRunRecord } from "@nzi/isolated-backend";
import { NAV, USER } from "../../lib/nav";
import { formatDate } from "../../lib/formatDate";
import { useEditAccess } from "../../lib/useEditAccess";
import { crumbTrail, jobCrumbs } from "../../lib/crumbTrail";

/**
 * The staff training module (`job_training_v1`).
 *
 * The **run** is the versioned, reviewed unit: reviewing it freezes the attendance register
 * and the issued certificates into a content-addressed snapshot, and the family report and
 * both portals read that snapshot rather than recomputing anything. Every figure here —
 * attendance, certificate state, places — is derived from the rows, never typed.
 *
 * This speaks the staff register deliberately: *remaining · consumed / reserved / available*.
 * The client portal says the same things in the benefit register; the two are kept distinct
 * on purpose.
 */

const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;

export function TrainingWorkspace({ job, runs, today, writeEnabled }: {
  job: FamilyJob; runs: TrainingRunRecord[]; today: string; writeEnabled: boolean;
}) {
  const { header } = job;
  const meta = jobFamilyMeta[header.family];
  const [runIndex, setRunIndex] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const record = runs[runIndex] ?? null;

  const manage = useEditAccess("training.manage", writeEnabled);
  const review = useEditAccess("snapshot.review", writeEnabled);
  const places = useEditAccess("training.entitlement.manage", writeEnabled);

  return <AppShell rail={<WorkspaceRail sections={NAV} activeId="jobs" user={USER} />}>
    <TopBar searchPlaceholder="Search trainees, sessions…" crumbs={crumbTrail(jobCrumbs(header, { label: "Training run" }))} />
    <div className="nz-head nz-family-head"><div className="nz-job-heading">
      <div>
        <div className="nz-family-titleline"><span className="nz-eyebrow">{meta.label}</span><span className="nz-st est">{meta.code}</span></div>
        <h1>{header.number} — {record?.run.runName ?? header.title}</h1>
        <div className="sub">{header.client} · lead {header.owner}
          {record?.run.startDate ? <> · run window {formatDate(record.run.startDate)}{record.run.endDate ? ` – ${formatDate(record.run.endDate)}` : ""}</> : null}</div>
      </div>
      <span className="nz-status"><span className="d" />{record ? trainingRunStageLabels[record.run.workflowStageKey as TrainingRunStage] ?? record.run.workflowStageKey : header.workflowStage}</span>
    </div></div>

    <div className="nz-body nz-family-body">
      {notice ? <div className="nz-banner ok" role="status">{notice}</div> : null}
      {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}

      {runs.length === 0
        ? <section className="nz-panel"><div className="nz-card-b">
          <p className="sub" style={{ margin: "8px 0" }}>No course run has been set up for this engagement yet. A run is one delivery of a product — its sessions, its bookings and its certificates all hang off it.</p>
          <p className="nz-maps">Nothing is shown here rather than an empty register that could be mistaken for a run with no one booked.</p>
        </div></section>
        : null}

      {runs.length > 1 ? <div className="nz-toolbar" style={{ padding: "0 0 12px" }}><div className="nz-filters">
        {runs.map((entry, index) => <button key={entry.run.id} type="button" aria-pressed={index === runIndex}
          className={index === runIndex ? "on" : undefined} onClick={() => setRunIndex(index)}>{entry.run.runName ?? `Run ${index + 1}`}</button>)}
      </div></div> : null}

      {record ? <RunView record={record} today={today} manage={manage} review={review} places={places}
        onNotice={(text) => { setNotice(text); setError(null); }} onError={(text) => { setError(text); setNotice(null); }} /> : null}
    </div>
  </AppShell>;
}

function RunView({ record, today, manage, review, places, onNotice, onError }: {
  record: TrainingRunRecord;
  today: string;
  manage: ReturnType<typeof useEditAccess>;
  review: ReturnType<typeof useEditAccess>;
  places: ReturnType<typeof useEditAccess>;
  onNotice: (text: string) => void;
  onError: (text: string) => void;
}) {
  const { run, product, sessions, bookings, attendance, certificates, minAttendancePct } = record;
  const summary = trainingRunSummary({
    bookings, sessions, attendance, capacity: run.capacity,
    certificatesIssued: certificates.filter((certificate) => certificate.status === "issued").length,
    minAttendancePct,
  });
  const stage = run.workflowStageKey as TrainingRunStage;
  const stageIndex = trainingRunStages.indexOf(stage);
  const groups = trainingPlaceGroups(record.entitlements, today);
  const reviewed = run.reviewStatus === "approved";

  return <>
    {/* The run's own stages — a job is the engagement, a run is one delivery of it. */}
    <section className="nz-panel nz-run-stage">
      {trainingRunStages.map((entry, index) => <div key={entry}
        className={`nz-run-step${index < stageIndex ? " done" : index === stageIndex ? " now" : ""}`}>
        <b>{index + 1}</b><span>{trainingRunStageLabels[entry]}</span>
      </div>)}
      <span className="sp" />
      {/* One stage at a time, in both directions — the same discipline as the job spine. */}
      {[-1, 1].map((step) => {
        const target = trainingRunStages[stageIndex + step];
        if (!target) return null;
        return <GatedButton key={target} className={step === 1 ? "nz-btn pri" : "nz-btn"}
          blocked={reviewed || manage.state !== "allowed"}
          blockedReason={reviewed ? "This run is reviewed — reopen it to change its stage." : manage.state === "allowed" ? undefined : manage.reason}
          reasonClassName="hint nz-gated-reason"
          onClick={async () => {
            const result = await patchBrowserCommand<{ stage: string }>(`/api/isolated/training/runs/${encodeURIComponent(run.id)}`,
              { fromStage: stage, toStage: target, expectedVersion: run.version }, crypto.randomUUID());
            if (result.state !== "success") { onError(errorText(result)); return; }
            onNotice(`Run moved to ${trainingRunStageLabels[target]}.`);
          }}>{step === 1 ? `Move to ${trainingRunStageLabels[target]}` : `Back to ${trainingRunStageLabels[target]}`}</GatedButton>;
      })}
    </section>

    <section className="nz-panel">
      <div className="nz-card-h"><span className="eyebrow">Run</span><h2>Overview</h2><span className="sp" />
        {reviewed ? <span className="nz-st done">Reviewed · frozen</span> : <span className="nz-st est">v{run.version} · draft</span>}</div>
      <div className="nz-card-b"><div className="nz-run-kv">
        <Fact label="Product" value={product?.productName ?? "Not set"} />
        <Fact label="Delivery" value={`${run.deliveryMode.replace("_", " ")} · ${sessions.length} session${sessions.length === 1 ? "" : "s"}`} />
        <Fact label="Booked" value={String(summary.booked)} note={run.capacity === null ? "no cap set" : `/ ${run.capacity} cap`} big />
        <Fact label="Entitlement-funded" value={String(summary.entitlementFunded)} big />
        <Fact label="Certificates ready" value={String(summary.certificatesReady)} note={summary.certificatesHeld ? `${summary.certificatesHeld} held` : undefined} big />
        <Fact label="Attendance" value={summary.attendancePct === null ? "—" : `${summary.attendancePct}%`} note={summary.attendancePct === null ? "nobody booked" : "mean across bookings"} />
      </div></div>
    </section>

    <section className="nz-panel">
      <div className="nz-card-h"><span className="eyebrow">Schedule</span><h2>Sessions</h2><span className="sp" />
        <span className="hint">attendance captured per session</span></div>
      {sessions.length === 0
        ? <div className="nz-card-b"><p className="sub">No sessions are scheduled for this run yet.</p></div>
        : sessions.map((session) => {
          const present = attendance.filter((entry) => entry.sessionId === session.id && entry.attendanceStatus === "present").length;
          const expected = bookings.filter((booking) => booking.attendanceStatus !== "cancelled" && booking.attendanceStatus !== "waitlisted").length;
          return <div className="nz-session" key={session.id}>
            <div className="nz-session-date">
              <b>{session.sessionDate ? formatDate(session.sessionDate).slice(0, 2) : "—"}</b>
              <span>{session.sessionDate ? new Date(`${session.sessionDate}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }) : ""}</span>
            </div>
            <div className="nz-session-main">
              <div className="nm">{session.sessionTitle ?? "Session"}</div>
              <div className="sub">
                <NziIcon name={session.deliveryMode === "online" ? "video" : "calendar"} size={14} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                {session.deliveryMode === "online" ? `Online${session.onlineMeetingUrl ? " · joining link set" : ""}` : session.venueName ?? "In person"}
                {session.status === "scheduled" ? <span className="nz-st est" style={{ marginLeft: 8 }}>Upcoming</span> : null}
              </div>
            </div>
            <div className="nz-session-att">
              {session.status === "delivered"
                ? <><b>{present}/{expected}</b><span>present</span></>
                : <span className="muted">Not yet delivered</span>}
            </div>
          </div>;
        })}
    </section>

    <BookingRegister record={record} minAttendancePct={minAttendancePct} manage={manage} reviewed={reviewed}
      onNotice={onNotice} onError={onError} />

    <section className="nz-panel">
      <div className="nz-card-h"><span className="eyebrow">Places</span><h2>Entitlements for this client</h2><span className="sp" />
        <span className="hint">granted by CRP jobs · consumed by bookings above</span></div>
      {groups.length === 0
        ? <div className="nz-card-b"><p className="sub">This client holds no training places. Places are granted by a CRP job, from the quote or as a manual grant.</p></div>
        : groups.map((group) => <PlaceRow key={group.key} group={group} places={places} onNotice={onNotice} onError={onError} />)}
      <div className="nz-card-b nz-place-legend">
        <span className="hint"><i className="nz-dot used" /> consumed &nbsp; <i className="nz-dot resv" /> reserved &nbsp; <i className="nz-dot" /> available &nbsp; <i className="nz-dot lapsed" /> lapsed</span>
        <span className="sp" /><span className="hint">expiry is movable here, with a reason</span>
      </div>
    </section>

    <div className="nz-gov"><span className="lk" aria-hidden="true"><NziIcon name="shield" size={14} /></span><span>
      The <b>run</b> is the versioned, reviewed unit. Reviewing it freezes the attendance register and issued
      certificates into a content-addressed snapshot — the same snapshot the family report and both portals read,
      so none of them recompute. Certificates issue on policy (≥{minAttendancePct}% attendance) and are held where
      consent is pending. Every booking references a portable trainee record plus the employer and funding frozen at
      booking; places consume atomically. Deactivate, never delete; every change writes an audit event.
    </span></div>

    <div className="nz-run-actions">
      <GatedButton className="nz-btn" blocked={reviewed || review.state !== "allowed"}
        blockedReason={reviewed ? "This run is reviewed — its register is frozen." : review.state === "allowed" ? undefined : review.reason}
        reasonClassName="hint nz-gated-reason"
        onClick={async () => {
          const result = await putBrowserCommand<{ reused: boolean }>(`/api/isolated/training/runs/${encodeURIComponent(run.id)}`,
            { expectedVersion: run.version }, crypto.randomUUID());
          if (result.state !== "success") { onError(errorText(result)); return; }
          onNotice(result.data.reused ? "Already reviewed — the same facts, so the same snapshot." : "Run reviewed. The register and its certificates are frozen.");
        }}>Review run</GatedButton>
    </div>
  </>;
}

function BookingRegister({ record, minAttendancePct, manage, reviewed, onNotice, onError }: {
  record: TrainingRunRecord; minAttendancePct: number;
  manage: ReturnType<typeof useEditAccess>; reviewed: boolean;
  onNotice: (text: string) => void; onError: (text: string) => void;
}) {
  const { run, sessions, bookings, attendance, certificates } = record;
  const certificateFor = (bookingId: string) => certificates.find((certificate) => certificate.bookingId === bookingId && certificate.status === "issued") ?? null;

  return <section className="nz-panel">
    <div className="nz-card-h"><span className="eyebrow">Register</span><h2>Bookings</h2><span className="sp" />
      <span className="hint">a certificate issues at ≥{minAttendancePct}% attendance across sessions</span></div>
    {bookings.length === 0
      ? <div className="nz-card-b"><p className="sub">Nobody is booked onto this run yet.</p></div>
      : <table className="nz-tbl">
        <thead><tr><th>Trainee</th><th>Employer</th><th>Funding</th><th>Attendance</th><th>Consent</th><th>Certificate</th></tr></thead>
        <tbody>
          {bookings.map((booking) => {
            const { attendancePct } = trainingAttendanceForBooking(booking.id, sessions, attendance);
            const decision = trainingCertificateDecision({ booking, sessions, attendance, minAttendancePct });
            const certificate = certificateFor(booking.id);
            return <tr key={booking.id}>
              <td>
                <b>{booking.personName}</b>
                {booking.attendanceStatus === "waitlisted" ? <span className="nz-tag" style={{ marginLeft: 6 }}>Waitlist</span> : null}
                <div className="muted">{booking.personEmail ?? "No email recorded"}</div>
              </td>
              <td>{booking.employerName ?? <span className="muted">Not recorded</span>}
                {booking.isGuest ? <span className="nz-tag" style={{ marginLeft: 6 }}>guest</span> : null}</td>
              <td>{booking.entitlementId
                ? <span className="nz-tag rr"><NziIcon name="ticket" size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />Place</span>
                : <span className="nz-tag">Billed</span>}</td>
              <td><span className="nz-att"><i><span style={{ width: `${attendancePct}%` }} /></i><b className="num">{attendancePct}%</b></span></td>
              <td><span className={booking.consentStatus === "granted" ? "ok" : "up"}>
                {booking.consentStatus === "granted" ? "Given" : booking.consentStatus === "declined" ? "Declined" : "Pending"}</span></td>
              <td>{certificate
                ? <span className="ok"><NziIcon name="award" size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />Issued</span>
                : decision.state === "held"
                  ? <span className="up" title={decision.reason}><NziIcon name="award" size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />Ready — held</span>
                  : decision.state === "eligible"
                    ? <span className="muted">Ready to issue</span>
                    : <span className="muted" title={decision.reason}>Below threshold</span>}</td>
            </tr>;
          })}
        </tbody>
      </table>}
    <div className="nz-card-b nz-run-actions">
      <GatedButton className="nz-btn pri" blocked={reviewed || manage.state !== "allowed"}
        blockedReason={reviewed ? "This run is reviewed — its certificates are frozen." : manage.state === "allowed" ? undefined : manage.reason}
        reasonClassName="hint nz-gated-reason"
        onClick={async () => {
          const result = await postBrowserCommand<{ issued: number; held: number; notEligible: number }>(
            `/api/isolated/training/runs/${encodeURIComponent(run.id)}`, { expectedRunVersion: run.version }, crypto.randomUUID());
          if (result.state !== "success") { onError(errorText(result)); return; }
          const { issued, held } = result.data;
          onNotice(issued === 0
            ? held > 0 ? `No certificate issued — ${held} held on consent.` : "No booking currently meets the policy."
            : `${issued} certificate${issued === 1 ? "" : "s"} issued${held ? `, ${held} held on consent` : ""}.`);
        }}>
        <NziIcon name="award" size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />Issue eligible certificates
      </GatedButton>
    </div>
  </section>;
}

function PlaceRow({ group, places, onNotice, onError }: {
  group: ReturnType<typeof trainingPlaceGroups>[number];
  places: ReturnType<typeof useEditAccess>;
  onNotice: (text: string) => void; onError: (text: string) => void;
}) {
  const [moving, setMoving] = useState(false);
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const { summary, expiry } = group;

  return <div className="nz-ent">
    <span className="nz-ent-icon"><NziIcon name="ticket" size={18} /></span>
    <div className="nz-ent-main">
      <div className="nm">{group.courseLabel || "Training places"} — {summary.granted} place{summary.granted === 1 ? "" : "s"}</div>
      <div className="sub">Granted by <Link className="nz-table-link" href={`/jobs/${encodeURIComponent(group.sourceJobId)}`}>{group.sourceJobNumber}</Link>
        {" · "}
        {/* The staff register: mechanism, and it says whether the date was chosen. */}
        {expiry.state === "lapsed"
          ? <span className="nz-expiry lapsed">Lapsed · {group.unusedAtExpiry} unused</span>
          : expiry.state === "expiring"
            ? <span className="nz-expiry warn">expires {formatDate(expiry.expiresAt)}{expiry.fromJobEnd ? " (job end · movable)" : ""}</span>
            : expiry.state === "active"
              ? <span className="nz-expiry ok">expires {formatDate(expiry.expiresAt)}{expiry.fromJobEnd ? " (job end · movable)" : ""}</span>
              : <span className="muted">no expiry set</span>}
      </div>
      <div className="nz-places">
        {group.places.map((state, index) => <i key={index} className={`nz-dot${state === "consumed" ? " used" : state === "reserved" ? " resv" : state === "lapsed" ? " lapsed" : ""}`} />)}
      </div>
      {moving ? <div className="nz-place-move">
        <label className="nz-fl"><span>New expiry</span><input className="nz-inp" type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <label className="nz-fl"><span>Reason</span><input className="nz-inp" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why this place is being extended" /></label>
        <GatedButton className="nz-btn" blocked={!reason.trim()} blockedReason={reason.trim() ? undefined : "A reason is required."}
          reasonClassName="hint nz-gated-reason"
          onClick={async () => {
            const result = await putBrowserCommand<{ entitlementIds: string[] }>("/api/isolated/training/entitlements",
              { entitlementIds: group.movableEntitlementIds, expiresAt: date || null, reason }, crypto.randomUUID());
            if (result.state !== "success") { onError(errorText(result)); return; }
            const moved = result.data.entitlementIds.length;
            setMoving(false); setReason("");
            onNotice(`Expiry moved on ${moved} place${moved === 1 ? "" : "s"}. It is no longer the job-end default, and the change is on the audit trail.`);
          }}>Save expiry</GatedButton>
      </div> : null}
    </div>
    <div className="nz-ent-rem">
      <div className="v num">{summary.available}</div>
      <div className="l">remaining</div>
      <GatedButton className="nz-editlink" blocked={places.state !== "allowed" || summary.available + summary.reserved + summary.lapsed === 0}
        blockedReason={places.state !== "allowed" ? places.reason : "Every place in this grant has been used, so its expiry no longer applies."}
        reasonClassName="hint nz-gated-reason"
        onClick={() => setMoving(!moving)}>{moving ? "Cancel" : "Move expiry"}</GatedButton>
    </div>
  </div>;
}

function Fact({ label, value, note, big }: { label: string; value: string; note?: string; big?: boolean }) {
  return <div className="nz-run-fact">
    <div className="k">{label}</div>
    <div className={big ? "v big num" : "v"}>{value}{note ? <small> {note}</small> : null}</div>
  </div>;
}
