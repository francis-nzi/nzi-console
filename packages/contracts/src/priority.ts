// Priority — how urgent a piece of work is. The one vocabulary every module shares (NZC-022 ruling on the SRS item,
// RULING-srs-assessment-priority-vocabulary.md): the SRS assessment item uses it first; the actions/strategies module
// imports this same type and CHECK vocabulary when it gains a priority, rather than defining its own.
//
// It is urgency, not certainty. The estimate-confidence scale (0085) happens to use the same three words but means
// something different, and shares neither this type nor a column with it.

/** Highest first: the order a list is sorted by. */
export const PRIORITIES = ["high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const priorityLabels: Readonly<Record<Priority, string>> = { high: "High", medium: "Medium", low: "Low" };

export function isPriority(value: unknown): value is Priority {
  return typeof value === "string" && (PRIORITIES as readonly string[]).includes(value);
}

/** 0 for high, 2 for low; an unset priority sorts after every set one. */
export function priorityRank(priority: Priority | null | undefined): number {
  return priority ? PRIORITIES.indexOf(priority) : PRIORITIES.length;
}

/** For `Array.sort`: high before medium before low before unset. */
export function comparePriority(a: Priority | null | undefined, b: Priority | null | undefined): number {
  return priorityRank(a) - priorityRank(b);
}
