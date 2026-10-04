"use client";

import { useEffect, useState } from "react";
import type { SmartSearchOption } from "@nzi/ui";

/**
 * The lists the Add-client smart-searches resolve against (NZC-089, redesign Part 2).
 *
 * Three fetches, each reported separately. A list that failed to load and a list that is genuinely
 * empty are different facts, and a smart-search that says "nothing to choose from" when the request
 * actually failed would send a consultant looking for a missing industry rather than a broken read
 * — the platform's oldest failure mode, applied to a dropdown.
 */

export type OptionList = {
  options: SmartSearchOption[];
  state: "loading" | "ready" | "failed";
  /** What to say when the list has nothing in it, which depends on why. */
  emptyHint: string;
};

const LOADING: OptionList = { options: [], state: "loading", emptyHint: "Loading…" };

async function fetchOptions(url: string, map: (body: never) => SmartSearchOption[]): Promise<OptionList> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    const options = map(await response.json() as never);
    return {
      options, state: "ready",
      emptyHint: "This list has no entries yet. An administrator curates it.",
    };
  } catch {
    return {
      options: [], state: "failed",
      // Named as a fault, so nobody reads an empty list as an empty world.
      emptyHint: "This list could not be loaded, so there is nothing to choose from — that is a fault, not an empty list.",
    };
  }
}

/**
 * The staff roster on its own.
 *
 * The Add-client form picks an owner and a client manager from it; the Create-job form picks a
 * client manager from it (redesign Part 1). One hook rather than two, so a job's client manager and
 * a client's can never resolve against different rosters — which would make "default the job from
 * the client" resolve to somebody the other list has never heard of.
 */
export function useTeamOptions(): OptionList {
  const [team, setTeam] = useState<OptionList>(LOADING);

  useEffect(() => {
    let live = true;
    void fetchOptions("/api/isolated/team", (body: { members?: Array<{ userId: string; displayName: string; role: string; named: boolean }> }) =>
      (body.members ?? []).map((member) => ({
        id: member.userId,
        label: member.displayName,
        // The role is the useful second line when picking a colleague; when the roster has no name
        // for someone the label is their handle, and saying so beats letting it pass as a name.
        hint: member.named ? member.role : `${member.role} · no name on the roster yet`,
      }))).then((value) => { if (live) setTeam(value); });
    return () => { live = false; };
  }, []);

  return team;
}

/** The lookup categories a client form searches; each can take a value added in place (CLIENT-06). */
export type ClientLookupCategory = "industries" | "referrals" | "portfolios";

export function useReferenceOptions(): { team: OptionList; industries: OptionList; referrals: OptionList; portfolios: OptionList; append: (category: ClientLookupCategory, option: SmartSearchOption) => void } {
  const team = useTeamOptions();
  const [industries, setIndustries] = useState<OptionList>(LOADING);
  const [referrals, setReferrals] = useState<OptionList>(LOADING);
  // CLIENT-01 — the portfolio is a lookup too (0138's `portfolios`).
  const [portfolios, setPortfolios] = useState<OptionList>(LOADING);

  useEffect(() => {
    let live = true;
    const settle = (set: (value: OptionList) => void) => (value: OptionList) => { if (live) set(value); };

    const values = (body: { values?: Array<{ valueId: string; label: string; code: string | null }> }) =>
      (body.values ?? []).map((value) => ({
        id: value.valueId,
        label: value.label,
        // Industries carry no SIC yet (live has none). When curation fills them in, the code
        // appears here and the auto-fill activates — without a code change.
        ...(value.code ? { hint: value.code } : {}),
      }));

    void fetchOptions("/api/isolated/lookups/industries", values).then(settle(setIndustries));
    void fetchOptions("/api/isolated/lookups/referrals", values).then(settle(setReferrals));
    void fetchOptions("/api/isolated/lookups/portfolios", values).then(settle(setPortfolios));

    return () => { live = false; };
  }, []);

  // A value just added in place joins its list at once, without refetching — the server has it too.
  const append = (category: ClientLookupCategory, option: SmartSearchOption) => {
    const add = (list: OptionList): OptionList => ({ ...list, state: "ready", options: [...list.options.filter((entry) => entry.id !== option.id), option].sort((a, b) => a.label.localeCompare(b.label)) });
    ({ industries: setIndustries, referrals: setReferrals, portfolios: setPortfolios })[category](add);
  };

  return { team, industries, referrals, portfolios, append };
}
