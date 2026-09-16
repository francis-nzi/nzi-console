"use client";

import { useCallback, useEffect, useState } from "react";
import { shouldAutoRun, tourForPath, type TourDefinition, type TourSeen } from "@nzi/contracts";
import { TOURS } from "./tours";

/**
 * The auto-run → replay → remember loop.
 *
 * Seen-state is fetched once per session and kept here, so the decision to auto-run is made
 * from what the *person* has seen rather than what this *browser* has seen — which is the
 * whole reason it is on the server.
 *
 * Three things this deliberately does not do:
 * - **It does not auto-run before the seen-state has loaded.** Running optimistically would
 *   teach the page again to someone who already knows it, every time they open it, until the
 *   fetch returned. Waiting costs a moment; guessing costs trust.
 * - **It does not block the page.** A failed fetch means no auto-run and a Guide tab that
 *   still offers replay — help failing should never be the reason someone cannot work.
 * - **It does not re-run on every navigation within a page.** Auto-run is considered once per
 *   tour, per person, per version.
 */
export function useTours(path: string) {
  const [seen, setSeen] = useState<TourSeen[] | null>(null);
  const [running, setRunning] = useState<TourDefinition | null>(null);
  const [considered, setConsidered] = useState<ReadonlySet<string>>(new Set());

  const tour = tourForPath(TOURS, path);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/isolated/tours", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ seen?: TourSeen[] }> : { seen: [] })
      // An unreachable help API means no tours, not a broken page.
      .catch(() => ({ seen: [] as TourSeen[] }))
      .then((body) => { if (!cancelled) setSeen(body.seen ?? []); });
    return () => { cancelled = true; };
  }, []);

  // Auto-run: once the record is in, and once per tour version per person.
  useEffect(() => {
    if (seen === null || tour === null || running !== null) return;
    const key = `${tour.id}@${tour.version}`;
    if (considered.has(key)) return;
    setConsidered((current) => new Set(current).add(key));
    if (shouldAutoRun(tour, seen)) setRunning(tour);
  }, [seen, tour, running, considered]);

  const finish = useCallback(async (outcome: { dismissed: boolean }) => {
    const finished = running;
    setRunning(null);
    if (finished === null) return;
    // Recorded locally first so the tour cannot re-run while the request is in flight; the
    // server is the durable copy, not the decision-maker for this session.
    setSeen((current) => [
      ...(current ?? []).filter((record) => !(record.tourId === finished.id && record.tourVersion === finished.version)),
      { tourId: finished.id, tourVersion: finished.version, dismissed: outcome.dismissed, seenAt: new Date().toISOString() },
    ]);
    try {
      await fetch("/api/isolated/tours", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tourId: finished.id, tourVersion: finished.version, dismissed: outcome.dismissed }),
      });
    } catch {
      // Not surfaced: failing to remember a tour is not something to interrupt someone over.
      // The worst case is being offered it again on another device.
    }
  }, [running]);

  /** Replay from the Guide tab — always available, whatever the seen-state says. */
  const replay = useCallback(() => { if (tour !== null) setRunning(tour); }, [tour]);

  return { tour, seen: seen ?? [], loaded: seen !== null, running, replay, finish };
}
