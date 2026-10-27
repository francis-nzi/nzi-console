// Data entry D3 (R2, R4): a spend line's identity across years and across imports (BUILD-dataentry-D3-pgs-specifics).
//
// - **Across years (R4):** a carried-forward line is keyed on its GL code — or, with none, its normalised description — exactly as
//   the D2 allocation map keys a line, so "the same line" means one thing whether it is being routed, carried or re-imported.
//   Structure is carried; values never are.
// - **Across imports (R2):** reconcile by reading first. Before anything is written, each line is matched against what the job
//   already holds: a line already there is not imported again, and a line whose GL code a carried-forward line holds (still empty)
//   fills that line rather than adding a second beside it.

import { spendAllocationKey } from "./spendAllocation";
import { spendImportRowKey } from "./spendImport";

/** R4: a carried line's identity — `gl:<code>`, else `description:<normalised>`; null when a line has neither. */
export function spendCarryKey(line: { glCode?: string | null; description?: string | null }): string | null {
  const key = spendAllocationKey(line);
  return key ? `${key.kind}:${key.key}` : null;
}

/**
 * R2: a line as the job already holds it — the same description, net value and GL code (the ALREADY_IMPORTED key) on the same
 * invoice date. The date is part of it so that twelve months of identical rent are twelve lines, not one line twelve times.
 */
export function spendImportLineIdentity(line: { description: string; netValue: number | null; glCode: string | null; invoiceDate: string | null }): string {
  return `${spendImportRowKey(line)}|${line.invoiceDate ?? ""}`;
}

export type SpendImportReconciliation =
  | { kind: "new" }
  | { kind: "already-imported" }
  | { kind: "fills-carried"; sourceId: string };

type ReconcilableLine = { description: string; netValue: number | null; glCode: string | null; invoiceDate: string | null; skip?: boolean };

/**
 * R2/R4, pure: each line in file order against the job's own lines. `existing` counts the job's live spend lines by identity — so
 * twelve identical lines already there absorb twelve in the file, not one. `carried` lists, by carry key, the carried-forward lines
 * still waiting for a figure. A line marked `skip` (blocked) is not reconciled and takes nothing from either: null.
 */
export function reconcileSpendImport(
  lines: readonly ReconcilableLine[],
  existing: ReadonlyMap<string, number>,
  carried: ReadonlyMap<string, readonly string[]>,
): Array<SpendImportReconciliation | null> {
  const held = new Map(existing);
  const slots = new Map([...carried].map(([key, ids]) => [key, [...ids]]));
  return lines.map((line) => {
    if (line.skip) return null;
    const identity = spendImportLineIdentity(line);
    const count = held.get(identity) ?? 0;
    if (count > 0) {
      held.set(identity, count - 1);
      return { kind: "already-imported" };
    }
    const key = spendCarryKey(line);
    const slot = key ? slots.get(key)?.shift() : undefined;
    return slot ? { kind: "fills-carried", sourceId: slot } : { kind: "new" };
  });
}
