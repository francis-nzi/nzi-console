"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TourDefinition, TourStep } from "@nzi/contracts";

/**
 * The coach-mark tour: a spotlight over the element being explained, and a card beside it.
 *
 * In-house rather than a library, for the same reason the charts are: it has to match the
 * app's conventions, respect its tokens, and be accountable for its own accessibility. It is
 * about a hundred lines, and a dependency would be harder to make theme-aware than to write.
 *
 * Accessibility is the substance here, not a pass at the end:
 * - focus moves to the step card and is **trapped** while the tour runs, so Tab cannot wander
 *   into the page behind a spotlight the person cannot see past;
 * - the card is a `dialog` with an `aria-live` region, so each step is announced;
 * - the whole tour is keyboard-driven — arrows and Enter to move, Escape to leave;
 * - focus returns where it came from when the tour ends;
 * - `prefers-reduced-motion` drops the spotlight transition rather than the spotlight.
 *
 * **A step whose anchor is not on the page is skipped, never guessed at.** A spotlight on
 * nothing, or on the wrong element, teaches something false — which is worse than a shorter
 * tour.
 */

type Rect = { top: number; left: number; width: number; height: number };

export function CoachMarks({ tour, onFinish }: {
  tour: TourDefinition;
  /** `dismissed` is true when they asked not to be shown it again. */
  onFinish: (outcome: { dismissed: boolean }) => void;
}) {
  // Only the steps whose anchors actually exist, resolved once when the tour starts.
  const steps = useMemo(
    () => tour.steps.filter((step) => document.querySelector(step.anchor) !== null),
    [tour]);
  const [index, setIndex] = useState(0);
  const [dismiss, setDismiss] = useState(false);
  const [rect, setRect] = useState<Rect | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  const step: TourStep | undefined = steps[index];

  const end = useCallback((outcome: { dismissed: boolean }) => {
    returnTo.current?.focus();
    onFinish(outcome);
  }, [onFinish]);

  useEffect(() => { returnTo.current = document.activeElement as HTMLElement | null; }, []);

  // Every tour with no runnable step ends immediately rather than showing an empty frame.
  useEffect(() => { if (steps.length === 0) onFinish({ dismissed: false }); }, [steps.length, onFinish]);

  // Follow the anchor: scroll it into view, measure it, and re-measure on resize or scroll —
  // a spotlight that drifts off its element is worse than none.
  useEffect(() => {
    if (step === undefined) return;
    const element = document.querySelector(step.anchor);
    if (element === null) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
    const measure = () => {
      const box = element.getBoundingClientRect();
      setRect({ top: box.top, left: box.left, width: box.width, height: box.height });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step]);

  useEffect(() => { card.current?.focus(); }, [index]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); end({ dismissed: dismiss }); return; }
      if (event.key === "ArrowRight") { event.preventDefault(); move(1); return; }
      if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); return; }
      // Trap: while a spotlight is up, Tab must not reach the page behind it.
      if (event.key === "Tab") {
        const focusable = card.current?.querySelectorAll<HTMLElement>("button, input, [href]");
        if (!focusable || focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  function move(by: number) {
    const next = index + by;
    if (next < 0) return;
    if (next >= steps.length) { end({ dismissed: dismiss }); return; }
    setIndex(next);
  }

  if (step === undefined || steps.length === 0) return null;

  // The card sits under the anchor where there is room, and above it otherwise.
  const below = rect !== null && rect.top + rect.height + 200 < window.innerHeight;
  const style = rect === null ? { top: "50%", left: "50%" } : {
    top: below ? rect.top + rect.height + 12 : Math.max(12, rect.top - 208),
    left: Math.min(Math.max(12, rect.left), window.innerWidth - 340),
  };

  return <>
    {/* The spotlight is a ring around the anchor rather than a mask over the page, so the
        element being explained stays exactly as legible as it normally is. */}
    {rect !== null ? <div className="nz-tour-spot" aria-hidden="true"
      style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }} /> : null}

    <div className="nz-tour-card" role="dialog" aria-modal="true" aria-label={`${tour.title}: step ${index + 1} of ${steps.length}`}
      ref={card} tabIndex={-1} style={style}>
      <div className="step">
        <span>Step {index + 1} / {steps.length}</span>
        <span className="bar"><i style={{ width: `${((index + 1) / steps.length) * 100}%` }} /></span>
      </div>
      {/* Announced as the step changes, so the tour works without sight of the spotlight. */}
      <div aria-live="polite">
        <h4>{step.title}</h4>
        <p>{step.body}</p>
        {step.action !== undefined ? <p className="do"><b>Try it:</b> {step.action}</p> : null}
      </div>
      <label className="dsa">
        <input type="checkbox" checked={dismiss} onChange={(event) => setDismiss(event.target.checked)} />
        Don&rsquo;t show this tour again
      </label>
      <div className="row">
        <button type="button" className="skip" onClick={() => end({ dismissed: dismiss })}>Skip</button>
        <span className="sp" />
        <button type="button" className="bk" onClick={() => move(-1)} disabled={index === 0}>Back</button>
        <button type="button" className="nx" onClick={() => move(1)}>
          {index === steps.length - 1 ? "Done" : "Next"}
        </button>
      </div>
    </div>
  </>;
}
