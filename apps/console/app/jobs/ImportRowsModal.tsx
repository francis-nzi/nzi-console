"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { postBrowserCommand, postBrowserCommandWithReason, type BrowserCommandResult } from "@nzi/api-client";
import { emissionCategoryTaxonomy, type V7ImportRefreshCommitted, type V7ImportRefreshPreview } from "@nzi/contracts";
import type { V7ImportCandidate, V7ImportFactorHit, V7ImportRows, V7ImportRowsAcceptItem, V7ImportRowsAcceptResult, V7ImportRowsRow } from "@nzi/isolated-backend";
import { Drawer } from "@nzi/ui";
import {
  bringInBlockers, editionLabel, fileableCategories, filterRows, groupRows, judgeHit, mergeCandidates, oneDp, pairGroups, partsLine, pendingAccepts, reasonOutcome, refusedOutcome, rowFigure, rowLabel, rowsProgress,
  scopeLines, suggestedAccepts, suggestedSummary, verdictWords,
  type BringInOutcome, type RowsGroup,
} from "./importRowsModel";
import { notAutomaticLine, refreshViewOf, type FastPathOutcome, type ImportRefreshState } from "./importRefreshView";

/**
 * "Import rows from the previous system" — one modal from the job (BRIEF-v7-import-rows-modal §C; the mockup and the agreed flow in
 * _handoff). It replaces the in-page preview, its flagged table and the bounce to Import reconciliation.
 *
 *   1. It reads the job's rows (the read the refresh runs, rolled back) with each row's candidates and verdicts.
 *   2. A row the ID matches cleanly comes in pre-accepted; "Accept all matched" writes those decisions in one request, and the
 *      import totals the previous system has dropped retire with them. A red or amber row is resolved here: the candidate table,
 *      and the smart search over the factor library. Each write is the existing decision command, so decisions persist — leave
 *      and come back, and the modal picks up where it was ("Save & resume later").
 *   3. "Accept & bring in": once nothing needs a person, the refresh in one action (Phase D) — refreshed there and then when the
 *      job is eligible, otherwise its preview, why, and the commit with a reason. The job's route refuses a commit unless every
 *      scope agrees with the previous system to one decimal place.
 * Plain words on screen: "scope total", never a symbol.
 */
type Applies = Extract<ImportRefreshState, { applies: true }>;
type Load = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; data: V7ImportRows };

/** A refusal's messages, one per issue — so the outcome can list each and name its rows. */
const failureLines = (result: BrowserCommandResult<unknown>): string[] => result.state === "validation_failed" && result.issues.length
  ? result.issues.map((issue) => issue.message) : result.state === "success" ? [] : [result.message];
const failureText = (result: BrowserCommandResult<unknown>) => result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ") || result.message
  : result.state === "success" ? "" : result.message;
const t = (value: number | null) => (value === null ? "—" : oneDp(value));
const qty = (value: number | null) => (value === null ? "—" : value.toLocaleString("en-GB", { maximumFractionDigits: 3 }));
const rate = (value: number) => value.toLocaleString("en-GB", { maximumFractionDigits: 5 });
const categoryName = (code: string | null) => emissionCategoryTaxonomy.find((entry) => entry.code === code)?.name ?? code ?? "";
/**
 * The row's "previous system" figure is recomputed from the one factor the previous system stores — not that system's own figure
 * (which, over two dataset years, it prices month by month). Said so wherever it is shown (two-dataset-year guard, 25 Nov).
 */
const FROM_FACTOR = "worked out from the previous system’s factor";
/** Over two calendar years, once its own figures are read (endpoint 2): the previous system's own figure, priced by month there. */
const OWN_FIGURE = "the previous system’s figure";
/** The period guard's refusal, at the top, in the refusal's own place. */
const periodOutcome = (message: string): BringInOutcome => ({ tone: "refused", title: message, lines: [], rows: [] });

export function ImportRowsModal({ state, open, onClose, onBroughtIn }: {
  state: Applies; open: boolean; onClose: () => void;
  /** After the job is brought in: one line for the panel to say. */
  onBroughtIn: (line: string) => void;
}) {
  const path = `/api/isolated/jobs/${encodeURIComponent(state.jobId)}/import-refresh`;
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [pass, setPass] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [collapseDone, setCollapseDone] = useState(true);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [preview, setPreview] = useState<V7ImportRefreshPreview | null>(null);
  const [notAutomatic, setNotAutomatic] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  // What bringing it in said, when it refused: shown at the top, in the reconcile strip's place.
  const [refusal, setRefusal] = useState<BringInOutcome | null>(null);
  const commitKey = useRef<string | null>(null);

  async function read(bump: boolean): Promise<V7ImportRows | null> {
    try {
      const response = await fetch(`${path}/rows`, { cache: "no-store" });
      const body = await response.json().catch(() => null) as { data?: V7ImportRows; message?: string } | null;
      if (!response.ok || !body?.data) { setLoad({ state: "failed", message: body?.message ?? "The rows could not be read just now." }); return null; }
      setLoad({ state: "ready", data: body.data });
      if (bump) setPass((value) => value + 1);
      return body.data;
    } catch { setLoad({ state: "failed", message: "The rows could not be read just now." }); return null; }
  }
  useEffect(() => {
    if (!open) return;
    setLoad({ state: "loading" }); setPreview(null); setNotAutomatic(null); setError(null); setNotice(null); setRefusal(null);
    void read(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one read each time the modal opens
  }, [open, state.jobId]);

  /** Decisions are checked against the job's stored summary: store the one shown first, as "Resolve here" did. */
  async function ensureSummary(data: V7ImportRows): Promise<boolean> {
    if (data.summaryCurrent) return true;
    const stored = await postBrowserCommand(`${path}/summary`, {}, crypto.randomUUID());
    if (stored.state !== "success") { setError(failureText(stored)); return false; }
    return true;
  }
  async function accept(items: V7ImportRowsAcceptItem[], data: V7ImportRows): Promise<V7ImportRows | null> {
    if (!items.length) return data;
    if (!(await ensureSummary(data))) return null;
    const result = await postBrowserCommand<V7ImportRowsAcceptResult>(`${path}/rows/accept`, { items }, crypto.randomUUID());
    if (result.state !== "success") { setError(failureText(result)); return read(true); }
    const { written, unchanged, refused } = result.data;
    setNotice(`${written.length} decision${written.length === 1 ? "" : "s"} saved${unchanged.length ? ` · ${unchanged.length} already so` : ""}.`);
    if (refused.length) setError(`${refused.length} row${refused.length === 1 ? " was" : "s were"} not accepted: ${refused.slice(0, 3).map((entry) => `${entry.legacyDbId} — ${entry.message}`).join(" ")}`);
    return read(true);
  }
  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try { await work(); } finally { setBusy(false); }
  }
  const save = (items: V7ImportRowsAcceptItem[]) => run(async () => {
    if (load.state !== "ready") return;
    setPreview(null); setNotAutomatic(null); setRefusal(null);
    const after = await accept(items, load.data);
    if (after) setOpenRow(null);
  });
  const saveAndClose = () => run(async () => {
    if (load.state === "ready" && state.canResolve && state.writeEnabled) {
      const after = await accept(pendingAccepts(load.data.rows), load.data);
      if (!after) return;
    }
    onClose();
  });
  const bringIn = () => run(async () => {
    if (load.state !== "ready") return;
    let data: V7ImportRows | null = load.data;
    if (bringInBlockers(data.rows).length) return;
    setRefusal(null);
    const pending = pendingAccepts(data.rows);
    if (pending.length) {
      if (!state.canResolve) { setError("An Admin accepts the matched rows first."); return; }
      data = await accept(pending, data);
      if (!data || bringInBlockers(data.rows).length) return;
    }
    // Phase D: one action — refreshed there and then when the job is eligible; otherwise its preview and why.
    const result = await postBrowserCommand<FastPathOutcome>(path, { mode: "auto" }, crypto.randomUUID());
    if (result.state !== "success") { setRefusal(refusedOutcome(failureLines(result))); return; }
    commitKey.current = null;
    if (result.data.fastPath === "refreshed") { onBroughtIn("Brought in automatically: the job's rows now match the previous system, and wait for a reviewer's attest."); onClose(); return; }
    setPreview(result.data.preview); setNotAutomatic(notAutomaticLine(result.data));
  });
  const commit = () => run(async () => {
    if (!preview || !reason.trim()) return;
    const result = await postBrowserCommandWithReason<V7ImportRefreshCommitted>(path,
      { mode: "commit", summarySha256: preview.summarySha256, decisionsSha256: preview.decisionsSha256 }, commitKey.current ??= crypto.randomUUID(), reason.trim());
    if (result.state !== "success") { if (result.state !== "failed" || !result.retryable) commitKey.current = null; setRefusal(refusedOutcome(failureLines(result))); return; }
    commitKey.current = null; setReason("");
    onBroughtIn(`Brought in: re-synced ${result.data.resync.superseded + result.data.resync.added + result.data.resync.withdrawn} row(s); the new entries wait for a reviewer's attest.`);
    onClose();
  });

  const title = "Import rows from the previous system";
  return <Drawer open={open} onClose={onClose} ariaLabel={title} className="nz-import-modal">
    <div className="nz-import-modal-card nz-irm" data-import-rows={state.jobId}>
      <div className="nz-import-modal-h">
        <div><h2>{title}</h2><div className="nz-irm-sub">{state.legacyJobNumber} · match each row to a console factor, check the figures, accept. Reading changes nothing.</div></div>
        <button type="button" className="nz-btn" data-drawer-close aria-label="Close import rows" onClick={onClose}>✕</button>
      </div>
      {load.state === "loading" ? <div className="nz-import-modal-b"><div className="nz-list-empty" role="status"><b>Reading the job&rsquo;s rows from the previous system…</b></div></div> : null}
      {load.state === "failed" ? <div className="nz-import-modal-b"><div className="nz-banner warn" role="alert"><div>{load.message}</div></div></div> : null}
      {load.state === "ready" ? <ImportRowsView data={load.data} pass={pass} busy={busy} canResolve={state.canResolve} writeEnabled={state.writeEnabled}
        commitGated={state.commitNeedsAdmin && !state.isAdmin} error={error} notice={notice} filter={filter} onFilter={setFilter}
        collapseDone={collapseDone} onCollapse={() => setCollapseDone((value) => !value)} openRow={openRow} onOpenRow={setOpenRow}
        preview={preview} notAutomatic={notAutomatic} refusal={refusal} reason={reason} onReason={setReason}
        onSave={(items) => void save(items)} onSaveAndClose={() => void saveAndClose()} onBringIn={() => void bringIn()} onCommit={() => void commit()}
        search={(query, unit) => searchFactors(path, query, unit)} /> : null}
    </div>
  </Drawer>;
}

async function searchFactors(path: string, query: string, unit: string | null): Promise<{ hits: V7ImportFactorHit[]; familyless: string[] } | string> {
  try {
    const response = await fetch(`${path}/rows/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, unit }) });
    const body = await response.json().catch(() => null) as { data?: { hits: V7ImportFactorHit[]; familyless: string[] }; issues?: Array<{ message: string }>; message?: string } | null;
    if (!response.ok || !body?.data) return body?.issues?.[0]?.message ?? body?.message ?? "The factor library could not be searched just now.";
    return body.data;
  } catch { return "The factor library could not be searched just now."; }
}

export type ImportRowsViewProps = {
  data: V7ImportRows; pass: number; busy: boolean; canResolve: boolean; writeEnabled: boolean; commitGated: boolean;
  error: string | null; notice: string | null; filter: string; onFilter: (value: string) => void;
  collapseDone: boolean; onCollapse: () => void; openRow: string | null; onOpenRow: (legacyDbId: string | null) => void;
  preview: V7ImportRefreshPreview | null; notAutomatic: string | null;
  /** What bringing it in refused (the command's own refusal), when it did; the preview's refusal and its reasons come from `preview`. */
  refusal?: BringInOutcome | null;
  reason: string; onReason: (value: string) => void;
  onSave: (items: V7ImportRowsAcceptItem[]) => void; onSaveAndClose: () => void; onBringIn: () => void; onCommit: () => void;
  search: (query: string, unit: string | null) => Promise<{ hits: V7ImportFactorHit[]; familyless: string[] } | string>;
};

/** The modal's body: what one read shows. No requests of its own but the search it is handed. */
export function ImportRowsView(props: ImportRowsViewProps) {
  const { data, pass, busy, canResolve, writeEnabled, error, notice, filter, onFilter, collapseDone, onCollapse, preview } = props;
  const progress = rowsProgress(data.rows);
  const pending = pendingAccepts(data.rows);
  const mapsPending = pending.filter((item) => item.kind === "map").length;
  const retiringPending = pending.filter((item) => item.kind === "withdraw").length;
  const offPending = pending.filter((item) => item.kind === "map" && data.rows.some((row) => row.legacyDbId === item.legacyDbId && row.lane === "switched-off")).length;
  const suggested = suggestedAccepts(data.rows);
  const suggestedCount = suggestedSummary(data.rows);
  // "Accept all suggested" asks first: how many, by scope, a linked pair counted once.
  const [confirmSuggested, setConfirmSuggested] = useState(false);
  const acceptAllTitle = [offPending ? `${offPending} switched off in the previous system come in switched off, not counted.` : "",
    retiringPending ? `The ${retiringPending} import total${retiringPending === 1 ? "" : "s"} the previous system dropped retire with them.` : ""].filter(Boolean).join(" ") || undefined;
  const blockers = bringInBlockers(data.rows);
  const canWrite = canResolve && writeEnabled;
  const view = preview ? refreshViewOf(preview) : null;
  const previewTotals = view?.kind === "ready" ? Object.fromEntries(view.totals.map((entry) => [entry.scope, { v7Tco2e: entry.previous, liveTco2e: entry.live }])) as Parameters<typeof scopeLines>[1] : null;
  const lines = scopeLines(data, previewTotals);
  const allAgree = lines.every((line) => line.agrees === true);
  const anyOff = lines.some((line) => line.agrees === false);
  const waiting = lines.reduce((sum, line) => sum + line.waiting, 0);
  const shown = filterRows(data.rows, filter);
  const groups = groupRows(shown);
  const pct = (n: number) => `${progress.total ? (100 * n) / progress.total : 0}%`;
  const blocked = blockers.length > 0 || !writeEnabled || (pending.length > 0 && !canResolve) || data.periodRefusal !== null;
  // Ready: every row with a way in — matched, suggested, a pair to carry, a withdrawal to confirm — all but the reds.
  const ready = progress.total - progress.unmatched - progress.doubleCounted;
  // What bringing it in said, when it did not bring the job in: refused (the command, or the preview), or a reason it needs.
  // A job the period guard refuses (two dataset years, or none) says so first, before anything is tried, and shows nothing as agreeing.
  const outcome: BringInOutcome | null = data.periodRefusal !== null ? periodOutcome(data.periodRefusal) : props.refusal
    ?? (view?.kind === "refused" ? refusedOutcome(view.issues.map((issue) => issue.message))
      : preview && props.notAutomatic ? reasonOutcome(props.notAutomatic, preview.exceptions) : null);
  // Scrolled to, so it is never missed below the rows.
  const outcomeRef = useRef<HTMLDivElement | null>(null);
  const outcomeKey = outcome ? `${outcome.tone}|${outcome.lines.join("|")}` : "";
  useEffect(() => { if (outcomeKey) outcomeRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" }); }, [outcomeKey]);

  return <>
    <div className="nz-irm-prog" data-progress={`${progress.done}/${progress.total}`}>
      <div className="nz-irm-prog-l">
        <div><b>{progress.done} of {progress.total} rows done</b> <span className="nz-irm-pass" data-pass={pass}>Pass {pass}</span></div>
        <div>{progress.total - progress.done ? `${progress.total - progress.done} still to resolve` : "Nothing left to resolve"}</div>
      </div>
      <div className="nz-irm-bar" aria-hidden="true">
        <i className="g" style={{ width: pct(progress.matched) }} /><i className="a" style={{ width: pct(progress.suggested + progress.confirmOff + progress.doubleCounted + pairMembers(data.rows)) }} /><i className="r" style={{ width: pct(progress.unmatched) }} />
      </div>
      <div className="nz-irm-legend">
        <span><i className="nz-irm-dot g" /> {progress.matched} matched &amp; accepted</span>
        {progress.suggested ? <span><i className="nz-irm-dot a" /> {progress.suggested} suggested — confirm</span> : null}
        {progress.confirmOff ? <span><i className="nz-irm-dot a" /> {progress.confirmOff} gone — confirm off</span> : null}
        {progress.pairs ? <span><i className="nz-irm-dot a" /> {progress.pairs} linked pair{progress.pairs === 1 ? "" : "s"} to carry</span> : null}
        <span><i className="nz-irm-dot r" /> {progress.unmatched} need a match</span>
        {progress.switchedOff ? <span><i className="nz-irm-dot m" /> {progress.switchedOff} switched off in the previous system</span> : null}
        {progress.retiring ? <span><i className="nz-irm-dot m" /> {progress.retiring} import total{progress.retiring === 1 ? "" : "s"} retiring</span> : null}
      </div>
    </div>

    {outcome ? <div ref={outcomeRef} className={`nz-irm-rec ${outcome.tone === "refused" ? "bad" : "warn"}`} role="alert" data-outcome={outcome.tone}>
      <span><b>{outcome.title}</b></span>
      {outcome.lines.map((line, at) => <span key={at}>{line}</span>)}
      {outcome.rows.length ? <span data-outcome-rows={outcome.rows.join(",")}>Rows: <b>{outcome.rows.join(", ")}</b></span> : null}
    </div> : <div className={`nz-irm-rec${allAgree ? " ok" : anyOff ? " warn" : ""}`} role="status" data-reconcile={allAgree ? "agrees" : anyOff ? "differs" : "waiting"}>
      <span><b>{allAgree ? (data.ownFigures ? "✓ Scope totals match the previous system’s own, to 1 decimal place" : "✓ Scope totals match those worked out from the previous system’s factors, to 1 decimal place")
        : anyOff ? (data.ownFigures ? "A scope total does not agree yet with the previous system’s own" : "A scope total does not agree yet with the one worked out from the previous system’s factors")
          : `Waiting on ${waiting} row${waiting === 1 ? "" : "s"} before the scope totals can be checked`}</b></span>
      {lines.map((line) => <span key={line.scope} data-scope-line={line.scope} data-agrees={String(line.agrees)}>
        Scope {line.scope} total <b>{t(line.previous)}</b>{line.agrees === true ? " ✓" : line.agrees === false ? <> · here <b>{t(line.console)}</b> — does not agree</> : line.waiting ? ` · ${line.waiting} to go` : ""}
      </span>)}
      <span>{preview ? "as the refresh would bring it in" : "as worked out here"}</span>
    </div>}

    <div className="nz-irm-tb">
      <input className="nz-inp" aria-label="Filter rows" placeholder="Filter rows — ID, label, site, unit… (e.g. “van diesel miles”)" value={filter} onChange={(event) => onFilter(event.target.value)} />
      {mapsPending ? <button type="button" className="nz-btn" data-accept-all disabled={busy || !canWrite} onClick={() => props.onSave(pending)}
        title={acceptAllTitle}>Accept all {mapsPending} matched</button> : null}
      {suggestedCount.total ? <button type="button" className="nz-btn" data-accept-suggested disabled={busy || !canWrite} aria-expanded={confirmSuggested}
        onClick={() => setConfirmSuggested(true)}>Accept all {suggestedCount.total} suggested</button> : null}
      <button type="button" className="nz-btn" onClick={onCollapse}>{collapseDone ? "Show done" : "Collapse done"}</button>
    </div>
    {confirmSuggested && suggestedCount.total ? <SuggestedConfirm summary={suggestedCount} disabled={busy || !canWrite}
      onAccept={() => { setConfirmSuggested(false); props.onSave(suggested); }} onCancel={() => setConfirmSuggested(false)} /> : null}
    {!canResolve ? <div className="nz-banner warn" role="status" style={{ margin: "10px 18px 0" }}><div>An Admin accepts the rows; you can review them here.</div></div> : null}
    {!writeEnabled ? <div className="nz-banner warn" role="status" style={{ margin: "10px 18px 0" }}><div>Bringing rows in is not enabled in this environment.</div></div> : null}
    {data.firstTimeMapping ? <div className="nz-irm-sub" style={{ padding: "8px 18px 0" }}>Now has activity data in the previous system — map its rows.</div> : null}
    {error ? <div className="nz-banner warn" role="alert" style={{ margin: "10px 18px 0" }}><div>{error}</div></div> : null}
    {notice ? <div className="nz-banner ok" role="status" style={{ margin: "10px 18px 0" }}><div>{notice}</div></div> : null}

    <div className="nz-irm-rows">
      {groups.length ? <div className="nz-irm-colhd" data-row-header><span>Previous system row</span><span>Quantity</span><span>Console factor</span><span>Status</span><span>Here vs previous system</span></div> : null}
      {groups.map((group) => <Group key={group.key} group={group} {...props} canWrite={canWrite} />)}
      {groups.length === 0 ? <div className="nz-list-empty" role="status"><b>{filter ? "No row matches the filter." : "The previous system holds no rows for this job."}</b></div> : null}
    </div>

    <div className="nz-irm-ft">
      <div className="nz-irm-ft-l" data-blockers={blockers.length}>
        {blockers.length ? <><b>{blockers.join(" · ")}</b> · your decisions are saved as you go, so you can leave and come back.</>
          : view?.kind === "nothing" ? <b>Nothing to bring in: every row matches the previous system&rsquo;s record now.</b>
            : <>Everything is matched{mapsPending ? ` — ${mapsPending} accepted when you bring it in` : ""}. Your decisions are saved as you go.</>}
        {view?.kind === "ready" && anyOff ? <div role="alert">A scope does not agree to one decimal place, so it cannot be brought in. Investigate the scope&rsquo;s rows.</div> : null}
        {view?.kind === "ready" && allAgree && props.commitGated ? <div role="status">This organisation requires an Admin to bring a job in. You can check it; an Admin commits.</div> : null}
      </div>
      <div className="nz-irm-ft-r">
        <button type="button" className="nz-btn" disabled={busy} onClick={props.onSaveAndClose}>Save &amp; resume later</button>
        {view?.kind === "ready" && allAgree && !props.commitGated ? <>
          <input className="nz-inp" aria-label="Reason for bringing it in" placeholder="Reason for bringing it in" value={props.reason} onChange={(event) => props.onReason(event.target.value)} />
          <button type="button" className="nz-btn pri" data-commit disabled={busy || !props.reason.trim() || !writeEnabled} onClick={props.onCommit}>Bring it in</button>
        </> : <button type="button" className="nz-btn pri" data-bring-in disabled={busy || blocked} title={blockers.length ? `Resolve first: ${blockers.join("; ")}` : undefined}
          onClick={props.onBringIn}>Accept &amp; bring in — {ready} ready</button>}
      </div>
    </div>
  </>;
}

/** "Accept all suggested", asked first: how many, by scope — a linked pair counted once — before anything is written. */
export function SuggestedConfirm({ summary, disabled, onAccept, onCancel }: {
  summary: ReturnType<typeof suggestedSummary>; disabled: boolean; onAccept: () => void; onCancel: () => void;
}) {
  return <div className="nz-banner warn" role="alertdialog" aria-label="Accept all suggested" data-confirm-suggested style={{ margin: "10px 18px 0" }}>
    <div><b>Accept {summary.total} suggestion{summary.total === 1 ? "" : "s"}?</b>{" "}
      {summary.byScope.map((entry) => `Scope ${entry.scope}: ${entry.count}`).join(" · ")}
      {summary.pairs ? ` · a linked pair counts once (${summary.pairs} here)` : ""}. Each comes in on the factor shown beside it.</div>
    <div className="nz-irm-act">
      <button type="button" className="nz-btn pri" data-confirm-accept disabled={disabled} onClick={onAccept}>Accept them</button>
      <button type="button" className="nz-btn" onClick={onCancel}>Cancel</button>
    </div>
  </div>;
}

const pairMembers = (rows: readonly V7ImportRowsRow[]) => pairGroups(rows).reduce((sum, group) => sum + group.rows.length, 0);

function Group({ group, ...props }: ImportRowsViewProps & { group: RowsGroup; canWrite: boolean }) {
  if (group.key === "pairs") {
    return <>
      <div className="nz-irm-gh">{group.title} — {pairGroups(group.rows).length}</div>
      {pairGroups(group.rows).map((pair) => {
        const maps = pendingAccepts(pair.rows).filter((item) => item.kind === "map");
        return <div className="nz-irm-pair" key={pair.pairGroup} data-pair-group={pair.pairGroup}>
          <div className="nz-irm-pair-h"><span>⛓ Linked pair — {pair.rows.length} rows carried together, unlinked</span>
            <button type="button" className="nz-btn pri" data-carry disabled={props.busy || !props.canWrite}
              onClick={() => props.onSave([{ kind: "carry", legacyDbId: pair.rows[0]!.legacyDbId }, ...maps])}>Carry both</button></div>
          {pair.rows.map((row) => <Row key={row.legacyDbId} row={row} {...props} />)}
        </div>;
      })}
    </>;
  }
  // Matched rows show three when collapsed; switched-off rows collapse whole, unless one needs a person.
  const offCollapsed = group.key === "switched-off" && props.collapseDone && group.rows.every((row) => row.pick !== null);
  const visible = group.key === "matched" && props.collapseDone ? group.rows.slice(0, 3) : offCollapsed ? [] : group.rows;
  return <>
    <div className="nz-irm-gh" data-group={group.key}>{group.title} — {group.rows.length}{group.key === "matched" ? <span> · ID matched, figures tie out</span> : null}
      {group.key === "double-counted" ? <span> · bringing it in beside its rows would count the scope twice — switch it off in the previous system</span> : null}
      {group.key === "switched-off" ? <span> · come in switched off, as the previous system holds them — never counted</span> : null}</div>
    {visible.map((row) => <Row key={row.legacyDbId} row={row} {...props} />)}
    {visible.length < group.rows.length ? <div className="nz-irm-gh" style={{ background: "transparent", textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>+ {group.rows.length - visible.length} more {group.key === "switched-off" ? "switched-off" : "matched"} rows</div> : null}
  </>;
}

const LANE_PILL: Record<V7ImportRowsRow["lane"], { tone: "g" | "a" | "r" | "m"; text: string }> = {
  accepted: { tone: "g", text: "Accepted" }, "pre-accepted": { tone: "g", text: "Matched" }, "in-console": { tone: "g", text: "In the console" },
  suggested: { tone: "a", text: "Suggested — confirm" }, "confirm-off": { tone: "a", text: "Gone — confirm off" }, unmatched: { tone: "r", text: "No match" },
  retiring: { tone: "m", text: "Retires on accept" }, "switched-off": { tone: "m", text: "Switched off — not counted" },
};

function Row({ row, ...props }: ImportRowsViewProps & { row: V7ImportRowsRow; canWrite: boolean }) {
  const pill = row.totalStillCounted ? { tone: "a" as const, text: "Still counted" } : LANE_PILL[row.lane];
  const tone = row.lane === "retiring" || row.lane === "switched-off" ? "m" : pill.tone;
  const needsMap = row.ownStatus === "new" || row.ownStatus === "needs-mapping";
  const open = props.openRow === row.legacyDbId;
  const pick = row.pick;
  // Over two calendar years, with the previous system's own figures read: the row is judged against that figure, in yearly parts.
  const own = props.data.ownFigures && row.previousSystem !== null;
  const previousFigure = own ? row.previousSystem!.tco2e : row.previous.tco2e;
  const against = own ? OWN_FIGURE : FROM_FACTOR;
  const parts = own && row.lane !== "in-console" ? partsLine(pick) || null : null;
  const confirm = row.lane === "suggested" && pick && pick.match.categoryCode && !pick.invalid;
  const accept = (candidate: V7ImportCandidate, categoryCode: string) => props.onSave([{ kind: "map", legacyDbId: row.legacyDbId, categoryCode,
    datasetId: candidate.datasetId, factorId: candidate.factorId, expectedDecisionId: row.decision?.decisionId ?? null }]);
  const label = rowLabel(row);
  const here = pick?.match.tco2e !== undefined && pick?.match.tco2e !== null && row.lane !== "in-console" ? pick.match.tco2e : null;
  return <div className={`nz-irm-row ${tone}`} data-row={row.legacyDbId} data-lane={row.lane}>
    <div><div className="nz-irm-t" data-row-label>{label.text}</div><div className="nz-irm-s">{[label.siteInLabel ? null : row.previous.siteName, `Scope ${row.scope}`].filter(Boolean).join(" · ")}
      {row.resolution === "stale" ? " · the earlier decision no longer stands" : ""}</div>
      <div className="nz-irm-id">{row.legacyDbId} · {row.previous.factorCode ?? "—"}</div></div>
    <div className="num">{qty(row.previous.quantity)} <span className="nz-irm-s">{row.previous.unit ?? ""}</span></div>
    <div className="nz-irm-fac">{row.lane === "retiring" || row.lane === "in-console" || row.lane === "confirm-off" || row.totalStillCounted
      ? <div className="nz-irm-s">{row.lane === "retiring" ? "replaced by the activity rows" : row.lane === "confirm-off" ? "switches off when brought in" : row.intended.factorId ? `${categoryName(row.intended.categoryCode)} · ${row.intended.factorId}` : "carried as it stands"}</div>
      : pick ? <><div className="nz-irm-t" title={pick.label}>{pick.label}</div><div className="nz-irm-id">{pick.code} · {rate(pick.rate)}{pick.match.categoryCode ? ` · ${categoryName(pick.match.categoryCode)}` : ""}</div>
        {row.lane === "switched-off" ? <div className="nz-irm-s">the previous system&rsquo;s own factor · comes in switched off</div> : null}</>
        : <><div className="nz-irm-t" style={{ color: "var(--danger)" }}>— no console factor</div><div className="nz-irm-s">{row.lane === "switched-off" ? "switched off — needs its factor, to come in switched off" : "needs a match"}</div>
          {row.held ? <div className="nz-irm-s" data-held style={{ color: "var(--danger)" }}>{row.held}</div> : null}</>}</div>
    <div className="nz-irm-st">
      <span className={`nz-irm-pill ${pill.tone}`}>{pill.text}</span>
      <div className="nz-irm-act">
        {confirm ? <button type="button" className="nz-btn" disabled={props.busy || !props.canWrite} onClick={() => accept(pick!, pick!.match.categoryCode!)}>Confirm</button> : null}
        {row.lane === "confirm-off" ? <button type="button" className="nz-btn" disabled={props.busy || !props.canWrite}
          onClick={() => props.onSave([{ kind: "withdraw", legacyDbId: row.legacyDbId, expectedDecisionId: row.decision?.decisionId ?? null }])}>Confirm it goes off</button> : null}
        {needsMap && row.lane !== "retiring" ? <button type="button" className="nz-btn" aria-expanded={open} onClick={() => props.onOpenRow(open ? null : row.legacyDbId)}>
          {open ? "Close" : row.lane === "unmatched" || (row.lane === "switched-off" && !pick) ? "Find a factor" : "Change"}</button> : null}
      </div>
    </div>
    <div className="nz-irm-fig" data-figures={row.legacyDbId}>{row.lane === "switched-off" ? <span>not counted</span> : previousFigure === null ? null : <>
      {here !== null ? <><span>Here</span> {rowFigure(here)} <span>·</span> </> : null}<span>Previous system</span> {rowFigure(previousFigure)}
      {here !== null && pick!.match.verdict === "reproduces" && props.data.periodRefusal === null ? " ✓" : ""}
      <div className="nz-irm-s">tCO₂e, {against}</div></>}
      {parts ? <div className="nz-irm-s" data-parts={row.legacyDbId}>{parts}</div> : null}</div>
    {open ? <Resolve row={row} familyless={props.data.familyless} periodHeld={props.data.periodRefusal !== null} own={own} busy={props.busy} canWrite={props.canWrite} search={props.search} onUse={accept} /> : null}
  </div>;
}

/** The resolve control: the row's own candidates and the smart search, as one ranked table — Console factor · This row → tCO₂e · Factor rate · Use. */
function Resolve({ row, familyless, periodHeld, own = false, busy, canWrite, search, onUse }: {
  row: V7ImportRowsRow; familyless: string[]; periodHeld: boolean; own?: boolean; busy: boolean; canWrite: boolean;
  search: ImportRowsViewProps["search"]; onUse: (candidate: V7ImportCandidate, categoryCode: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<V7ImportCandidate[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [filing, setFiling] = useState<{ key: string; category: string } | null>(null);
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) { setHits([]); setSearchError(null); return; }
    let live = true;
    const timer = setTimeout(() => {
      void search(text, row.previous.unit).then((result) => {
        if (!live) return;
        if (typeof result === "string") { setHits([]); setSearchError(result); return; }
        setSearchError(null); setHits(result.hits.map((hit) => judgeHit(row, hit, result.familyless)));
      });
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [query, row, search]);
  const list = mergeCandidates(row.candidates, hits).slice(0, 12);
  const best = list.find((candidate) => candidate.match.verdict === "reproduces");
  const previousFigure = own ? row.previousSystem!.tco2e : row.previous.tco2e;
  const cue: ReactNode = previousFigure === null ? <>The previous system holds no figure for this row — pick the factor it should come in with.</>
    : <><b>{row.lane === "unmatched" ? "No match on the ID." : "Check the match."}</b> {own ? "The previous system’s own figure, priced by month there" : <>Worked out from the previous system&rsquo;s factor</>}: <strong>{t(previousFigure)} tCO₂e</strong> for {qty(row.previous.quantity)} {row.previous.unit ?? ""} — pick the factor that reproduces it.</>;
  return <div className="nz-irm-resolve" data-resolve={row.legacyDbId}>
    <div className="nz-irm-cue">{cue}</div>
    <input className="nz-inp" aria-label={`Search the factor library for row ${row.legacyDbId}`} placeholder="Search — ID, any words, unit (e.g. “car petrol small km”)" value={query} onChange={(event) => setQuery(event.target.value)} />
    <div className="nz-irm-s" style={{ margin: "4px 0 6px" }}>{searchError ?? (query.trim().length >= 2 ? `${hits.length} match${hits.length === 1 ? "" : "es"} in the library` : `${mergeCandidates(row.candidates, []).length} found by the row's ID`)}</div>
    <div className="nz-irm-opthd"><span>Console factor</span><span>This row → tCO₂e</span><span>Factor rate</span><span>Use</span></div>
    {list.length === 0 ? <div className="nz-irm-s" style={{ padding: "6px 10px" }}>Nothing found yet — search the library by any words of the factor.</div> : null}
    {list.map((candidate) => {
      const key = `${candidate.datasetId}|${candidate.factorId}`;
      const judged = verdictWords(candidate.match, row.scope, candidate.scopes, own);
      // Under the period guard nothing is shown as agreeing: the figure it is judged against is not the previous system's own.
      const words = periodHeld ? { ...judged, text: judged.text.replace(/^✓ /, "") } : judged;
      const options = fileableCategories(row, candidate, familyless);
      const chosen = filing?.key === key ? filing.category : candidate.match.categoryCode ?? "";
      return <div key={key} className={`nz-irm-opt${candidate === best ? " sel" : ""}`} data-candidate={key} data-verdict={candidate.match.verdict}>
        <div>{candidate.label}<div className="c">{candidate.code} · {editionLabel(candidate)}</div>
          {!candidate.match.categoryCode && options.length ? <label className="nz-irm-s">File under <select className="nz-sel" value={chosen} onChange={(event) => setFiling({ key, category: event.target.value })}>
            <option value="">Choose a Scope {row.scope} category</option>{options.map((option) => <option key={option.code} value={option.code}>{option.name}</option>)}</select></label> : null}
          {candidate.invalid ? <div className="nz-irm-s">{candidate.invalid}</div> : null}</div>
        <div className="nz-irm-calc">{t(candidate.match.tco2e)}<span className={words.tone}>{words.text}</span>
          {candidate.parts?.length ? <span className="nz-irm-s" data-candidate-parts={key}>{partsLine(candidate)}</span> : null}</div>
        <div className="nz-irm-rate">{rate(candidate.rate)}<br />kgCO₂e/{candidate.unit}</div>
        <button type="button" className={`nz-btn${candidate === best ? " pri" : ""}`} data-use={key} disabled={busy || !canWrite || !chosen || Boolean(candidate.invalid)}
          title={!options.length ? `Not a Scope ${row.scope} factor: it cannot be filed for this row.` : !chosen ? "Choose the category it is filed under." : candidate.invalid ?? undefined}
          onClick={() => onUse(candidate, chosen)}>Use</button>
      </div>;
    })}
  </div>;
}

