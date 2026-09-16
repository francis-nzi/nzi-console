/**
 * Product tours — **data, not code**.
 *
 * A tour is a list of steps, each naming an element on the page and what to say about it.
 * Nothing about the engine knows what any particular page contains, which is the point: a
 * page's tour is authored as that page is finished, reviewed like any other content, and
 * changed without touching the component that renders it.
 *
 * **Versioned with the page.** `version` is part of the identity a person's "seen" record is
 * keyed on, so bumping it re-surfaces the tour for people who saw the old one. That makes the
 * bump a deliberate editorial act — "this changed enough to be worth showing again" — rather
 * than a number nobody looks at. A typo fix does not warrant one; a changed workflow does.
 */

export type TourStep = {
  /**
   * A CSS selector for the element this step is about. Resolved at run time, and a step whose
   * anchor is not on the page is **skipped rather than guessed at** — a spotlight on nothing,
   * or on the wrong element, teaches the wrong thing.
   */
  anchor: string;
  title: string;
  body: string;
  /**
   * An optional thing to do at this step, phrased as an instruction to the person. The engine
   * never performs it: a tour that clicked things on a user's behalf would be changing their
   * data to explain their data.
   */
  action?: string;
};

export type TourDefinition = {
  id: string;
  /** Bump to re-surface the tour for everyone who saw an earlier one. */
  version: number;
  /** Which route this tour belongs to — matched by prefix against the current path. */
  path: string;
  title: string;
  /** Shown in the Guide tab, so someone can tell what they are about to be walked through. */
  summary: string;
  steps: TourStep[];
};

/** A person's record of a tour they have already been shown. */
export type TourSeen = {
  tourId: string;
  tourVersion: number;
  /** They asked not to see it again, rather than simply having reached the end. */
  dismissed: boolean;
  seenAt: string;
};

/**
 * The tour for a path, if there is one.
 *
 * Longest match wins, so `/clients/[id]` gets the client-workspace tour rather than the
 * clients-list one. Returns null where no tour has been authored yet, which is the normal
 * case while pages are still being completed.
 */
export function tourForPath(tours: readonly TourDefinition[], path: string): TourDefinition | null {
  const matches = tours
    .filter((tour) => path === tour.path || path.startsWith(tour.path === "/" ? "/" : `${tour.path}/`))
    .sort((a, b) => b.path.length - a.path.length);
  // The root tour would otherwise match every page.
  const exact = matches.find((tour) => tour.path !== "/" || path === "/");
  return exact ?? null;
}

/**
 * Whether a tour should run itself, given what this person has already seen.
 *
 * Auto-run is once per person per **version**. A seen record for an older version does not
 * suppress a newer one — that is the whole reason the version is part of the key.
 */
export function shouldAutoRun(tour: TourDefinition, seen: readonly TourSeen[]): boolean {
  return !seen.some((record) => record.tourId === tour.id && record.tourVersion === tour.version);
}

/**
 * Why the Guide tab says what it says about a tour.
 *
 * Four distinct states, and they are worth keeping apart: a tour nobody has authored yet is
 * not the same as one you have already done, and "you dismissed this" is not the same as
 * "you finished it".
 */
export type TourStatus =
  | { kind: "none"; detail: string }
  | { kind: "unseen"; detail: string }
  | { kind: "completed"; detail: string }
  | { kind: "dismissed"; detail: string }
  | { kind: "revised"; detail: string };

export function tourStatus(tour: TourDefinition | null, seen: readonly TourSeen[]): TourStatus {
  if (tour === null) {
    return {
      kind: "none",
      detail: "Tours are authored per page as each one is finished. When this page has one it appears here.",
    };
  }
  const forThisTour = seen.filter((record) => record.tourId === tour.id);
  const current = forThisTour.find((record) => record.tourVersion === tour.version);
  if (current === undefined) {
    return forThisTour.length > 0
      // Seen an earlier version: say so, rather than presenting it as brand new.
      ? { kind: "revised", detail: "This tour has been updated since you last saw it." }
      : { kind: "unseen", detail: "You have not been through this one yet." };
  }
  return current.dismissed
    ? { kind: "dismissed", detail: "You asked not to be shown this automatically. You can still replay it." }
    : { kind: "completed", detail: "You have been through this one. Replay it whenever you like." };
}
