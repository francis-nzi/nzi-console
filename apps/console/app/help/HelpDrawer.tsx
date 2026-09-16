"use client";

import { useEffect, useRef, useState } from "react";
import { GatedButton } from "@nzi/ui";
import { tourStatus, type TourDefinition, type TourSeen } from "@nzi/contracts";
import { KnowledgeLibrary, KnowledgeReview } from "../knowledge/KnowledgeViews";
import type { HelpPageContext } from "./helpContext";

/**
 * The help drawer — one surface, four things, always in the same place.
 *
 * Follows the side-panel anatomy (DESIGN_CONVENTIONS §3.4): a fixed header carrying the
 * eyebrow, title and the page context; an independently scrollable body; a pinned footer
 * whose action never scrolls out of reach. It is an **inline panel, not a modal overlay** —
 * `aria-modal="false"`, matching the prototype: help sits beside the work rather than
 * blocking it, so someone can read an answer and act on the page behind it.
 *
 * **Page-aware.** The header shows what the drawer knows about where you are, and that same
 * context is what Phase 1's Ask will send with a question. Showing it is the honest part:
 * the user can see what the assistant will be told before they ask.
 *
 * Accessibility: focus moves into the panel on open and returns to the `?` on close; Escape
 * closes; the tab list is a real `tablist` with arrow-key navigation; the Ask transcript is
 * an `aria-live` region so an answer is announced. Motion respects `prefers-reduced-motion`.
 */

const TABS = [
  { id: "ask", label: "Ask" },
  { id: "guide", label: "Guide" },
  { id: "library", label: "Library" },
  { id: "review", label: "Review" },
] as const;
type TabId = (typeof TABS)[number]["id"];

type TourPanel = {
  tour: TourDefinition | null;
  seen: readonly TourSeen[];
  /** False until the seen-state has arrived — "not seen yet" would otherwise be a guess. */
  loaded: boolean;
  onReplay: () => void;
};

export function HelpDrawer({ context, capabilities, onClose, returnFocusTo, tour: tourPanel }: {
  context: HelpPageContext;
  capabilities: { approve: boolean; publish: boolean };
  onClose: () => void;
  returnFocusTo: HTMLElement | null;
  tour: TourPanel;
}) {
  const [tab, setTab] = useState<TabId>("ask");
  const panel = useRef<HTMLDivElement>(null);
  const showReview = capabilities.approve || capabilities.publish;
  const tabs = TABS.filter((entry) => entry.id !== "review" || showReview);

  // Focus in on open, and back to the affordance on close — a keyboard user must not be
  // dropped at the top of the document when the panel goes away.
  useEffect(() => {
    panel.current?.focus();
    return () => returnFocusTo?.focus();
  }, [returnFocusTo]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onTabKey = (event: React.KeyboardEvent, index: number) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : (index - 1 + tabs.length) % tabs.length;
    setTab(tabs[next]!.id);
    (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
  };

  return (
    <aside className="nz-drawer nz-help" role="dialog" aria-modal="false" aria-label="Help"
      ref={panel} tabIndex={-1}>
      <div className="nz-dh">
        <div className="k">Help</div>
        <h3>{tabs.find((entry) => entry.id === tab)?.label}</h3>
        {/* What the drawer knows about where you are — shown, not merely used. */}
        <div className="m">
          <span className="nz-help-context" title="What this drawer knows about where you are">{context.label}</span>
        </div>
        <button type="button" className="x" onClick={onClose} aria-label="Close help">×</button>
      </div>

      <div className="nz-help-tabs" role="tablist" aria-label="Help sections">
        {tabs.map((entry, index) => (
          <button key={entry.id} type="button" role="tab" id={`help-tab-${entry.id}`}
            aria-selected={tab === entry.id} aria-controls={`help-panel-${entry.id}`}
            tabIndex={tab === entry.id ? 0 : -1}
            className={tab === entry.id ? "on" : undefined}
            onClick={() => setTab(entry.id)} onKeyDown={(event) => onTabKey(event, index)}>
            {entry.label}
          </button>
        ))}
      </div>

      <div className="nz-db" id={`help-panel-${tab}`} role="tabpanel" aria-labelledby={`help-tab-${tab}`}>
        {tab === "ask" ? <AskShell context={context} /> : null}
        {tab === "guide" ? <GuidePanel panel={tourPanel} /> : null}
        {/* The same components the /knowledge page renders — one implementation, two hosts. */}
        {tab === "library" ? <KnowledgeLibrary /> : null}
        {tab === "review" && showReview ? <KnowledgeReview capabilities={capabilities} /> : null}
      </div>

      <div className="nz-df">
        <span className="hint">Answers will cite their source. Nothing here changes your data.</span>
        <span className="sp" />
        <button type="button" className="nz-btn" onClick={onClose}>Close</button>
      </div>
    </aside>
  );
}

/**
 * Ask — a shell until Phase 1.
 *
 * Deliberately not a disabled box with nothing behind it: the two things that make this
 * surface trustworthy are present and visible now, so they are built into the shape rather
 * than bolted on once generation exists. Asking returns the **honest abstention** — which is
 * the truthful answer today, because nothing can ground one yet — and offers to capture the
 * question for the team, which is a real action that reaches the 0a pipeline.
 */
function AskShell({ context }: { context: HelpPageContext }) {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);

  return <>
    <p className="nz-maps">
      The assistant answers only from sources it can cite — approved knowledge and the product
      documentation — and says so plainly when it cannot. It never changes your data.
    </p>

    {/* The transcript. Announced, so an answer reaches a screen reader without a re-read. */}
    <div className="nz-help-thread" aria-live="polite">
      {asked === null
        ? <p className="sub">Ask about this page, or anything about the platform.</p>
        : <>
          <div className="nz-help-msg you"><b>You</b><span>{asked}</span></div>
          <div className="nz-help-msg nzi">
            <b>NZI Assistant</b>
            <span>
              I can&rsquo;t answer this yet — answering from the knowledge library is not switched on.
              I won&rsquo;t guess at it.
            </span>
            {/* The abstention is the point: an uncited answer is worse than none. */}
            <span className="nz-help-abstain">No grounded answer — nothing cited, so nothing claimed.</span>
          </div>
        </>}
    </div>

    {asked !== null ? <div className="nz-help-capture">
      <b>Capture this for the team</b>
      <p className="sub">
        Send it to the knowledge library as a draft. Someone with approval rights writes or checks the
        answer, and then it is here for everyone — and the assistant can cite it.
      </p>
      <a className="nz-btn sm" href="/knowledge">Open the knowledge library</a>
    </div> : null}

    <label className="nz-fl"><span>Your question</span>
      <textarea className="nz-notes" rows={2} value={question} placeholder={`e.g. What does "reviewed, not assured" mean?`}
        onChange={(event) => setQuestion(event.target.value)} />
    </label>
    <GatedButton className="nz-btn pri" blocked={question.trim() === ""}
      blockedReason={question.trim() === "" ? "Type a question first." : undefined}
      reasonClassName="hint nz-gated-reason"
      onClick={() => { setAsked(question.trim()); setQuestion(""); }}>
      Ask
    </GatedButton>
    <p className="nz-maps">
      It will be told you are on <b>{context.label}</b>.
    </p>
  </>;
}

/**
 * Guide — this page's tour, and whether you have been through it.
 *
 * Replay is always offered, whatever the seen-state says: the auto-run is a courtesy, and
 * someone who wants the tour again should never have to clear something to get it.
 */
function GuidePanel({ panel }: { panel: TourPanel }) {
  const status = tourStatus(panel.tour, panel.seen);
  return <>
    <p className="nz-maps">
      Guided tours walk through a page the first time you open it, and can be replayed here whenever
      you want them.
    </p>

    {panel.tour === null
      ? <div className="nz-help-empty">
        <b>No tour for this page yet</b>
        <span>{status.detail}</span>
      </div>
      : <div className="nz-help-tour">
        <b>{panel.tour.title}</b>
        <span className="sub">{panel.tour.summary}</span>
        <span className="nz-help-tour-meta">
          {panel.tour.steps.length} {panel.tour.steps.length === 1 ? "step" : "steps"}
          {/* Still loading is its own state: "you have not seen this" would be a guess. */}
          {panel.loaded ? ` · ${status.detail}` : " · checking what you have already seen…"}
        </span>
        <button type="button" className="nz-btn pri" onClick={panel.onReplay}>
          {status.kind === "unseen" || status.kind === "revised" ? "Take the tour" : "Replay the tour"}
        </button>
      </div>}
  </>;
}
