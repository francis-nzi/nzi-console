/**
 * Data entry D1 (27 Oct): an entry's **basis** — measured as **activity** (physical units against an activity factor) or as
 * **spend** (money against a spend factor). The first decision on every add-entry drawer.
 *
 * ## One definition: a spend entry is one recorded in a currency
 *
 * A scope row's unit already says which it is. PG&S rows have always been stored in `GBP` against a factor priced per `GBP`; an
 * activity row never is in a currency. So the basis is **read from the unit**, not stored beside it: an ISO-4217 code is spend,
 * anything else is activity. That keeps one answer to the question everywhere (the form, the write, the review) and gives every
 * row already written its basis without a backfill. The write path relies on the same reading — a currency entry against a
 * currency-priced factor is a spend entry, which any category may hold (R2).
 *
 * ## The default a drawer opens on
 *
 * The client's last choice for the category, else the organisation's admin default for it, else the seed: **the spend-native
 * categories — PG&S (3.1), Capital Goods (3.2), Investments (3.15) — open on Spend, every other category on Activity** (settled
 * 27 Oct; 3.2 and 3.15 added on the D1 review, D2 R7). Spend is only ever opened on where a spend factor is available; the toggle
 * still shows, with Spend disabled and a note, where none is (R1/R2).
 */
import { CURRENCY_CODE_PATTERN } from "./adminCommercialLookups";
import type { SpendAllocationEntry } from "./spendAllocation";

export const ENTRY_BASES = ["activity", "spend"] as const;
export type EntryBasis = (typeof ENTRY_BASES)[number];

export const isEntryBasis = (value: unknown): value is EntryBasis => value === "activity" || value === "spend";

export const ENTRY_BASIS_LABEL: Record<EntryBasis, string> = { activity: "Activity", spend: "Spend" };

/** An ISO-4217 code — the unit a spend entry is recorded in, and a spend factor is priced per. */
export const isCurrencyUnit = (unit: string | null | undefined): boolean => typeof unit === "string" && CURRENCY_CODE_PATTERN.test(unit.trim());

/** The basis a recorded unit says the entry has. No unit (a draft before its factor) says nothing: null. */
export function entryBasisOfUnit(unit: string | null | undefined): EntryBasis | null {
  if (typeof unit !== "string" || unit.trim() === "") return null;
  return isCurrencyUnit(unit) ? "spend" : "activity";
}

/** The categories the seed opens on Spend: PG&S, and since D2 (R7) Capital Goods and Investments. Every other category's seed is Activity. */
export const SEEDED_SPEND_CATEGORIES: readonly string[] = ["3.1", "3.2", "3.15"];

export const seededEntryBasis = (categoryCode: string): EntryBasis => (SEEDED_SPEND_CATEGORIES.includes(categoryCode) ? "spend" : "activity");

/** What the drawer opens a fresh entry on: the client's last choice, else the admin default, else the seed — never Spend where it cannot be chosen. */
export function openingEntryBasis(input: {
  categoryCode: string;
  clientChoice?: EntryBasis | null;
  organisationDefault?: EntryBasis | null;
  spendAvailable: boolean;
}): EntryBasis {
  const wanted = input.clientChoice ?? input.organisationDefault ?? seededEntryBasis(input.categoryCode);
  return wanted === "spend" && !input.spendAvailable ? "activity" : wanted;
}

/** Where the opening basis came from, for the drawer to say so. */
export function openingEntryBasisSource(input: { clientChoice?: EntryBasis | null; organisationDefault?: EntryBasis | null }): "client" | "organisation" | "seed" {
  return input.clientChoice ? "client" : input.organisationDefault ? "organisation" : "seed";
}

/** The basis settings a drawer reads for one job: the organisation's admin defaults and this client's last choices, by category. */
export type JobEntryBasis = {
  defaults: Record<string, EntryBasis>;
  choices: Record<string, EntryBasis>;
  /** The client's currency (clients.currency), which a fresh spend entry starts in (R3). */
  currency: string;
  /** D2: the client's live allocation map, which routes a spend line the drawer is given to its proper category. */
  allocations?: SpendAllocationEntry[];
  /** D3 (R1): the sites with a currency of their own (site id → ISO code); a spend line at one is captured in it, local-first. */
  siteCurrencies?: Record<string, string>;
};

/** One category's admin default as Admin lists it: the setting, if any, over the seed. */
export type EntryBasisDefaultRow = { categoryCode: string; name: string; scope: "1" | "2" | "3"; seed: EntryBasis; setting: EntryBasis | null; version: number | null };

/** The basis a write states must agree with the unit it is recorded in (when there is one). */
export function entryBasisUnitIssue(basis: EntryBasis | null | undefined, unit: string | null | undefined): string | null {
  if (basis == null) return null;
  const said = entryBasisOfUnit(unit);
  if (said === null || said === basis) return null;
  return basis === "spend"
    ? "A spend entry is recorded in a currency (an ISO code such as GBP)."
    : "An activity entry is recorded in a physical unit, not a currency — record money as a spend entry.";
}
