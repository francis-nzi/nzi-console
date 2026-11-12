import type { CommandIssue } from "./commands";
import { V7_IMPORT_SOURCE_SYSTEM, type V7ImportRowStatus, type V7ImportScope, type V7ImportSummaryRow } from "./v7ImportSummary";

/**
 * The import workbench, Phase 2 (BRIEF-v7-import-workbench-phase2; RULING-v7-import-pair-carry): a person resolves each row Phase
 * 1 flagged, and the decision is kept against the job as the in-system crosswalk (migration 0228). A decision is keyed on the
 * row's import identity — the previous system and its record id — not on the summary it was made against, so a fresh summary of
 * the same job still finds it. It holds ids, codes and enums only.
 *
 *   map      — a `new` or `needs-mapping` row: the category and factor it is re-ingested under (the crosswalk entry);
 *   withdraw — a `withdrawn` row: confirmed gone from the previous system, so it switches off at ingest;
 *   carry    — every member of a linked pair group that moved: how the pair carries. One option, ruled: **A**, carry both,
 *              unlinked — the members become independent rows, as the re-ingest already writes them. The other way out is to
 *              hold (fix it in the previous system and re-extract), which records nothing.
 *
 * A row holds at most one current resolution (map or withdraw) and, in a pair, one current carry. A `changed` row is accepted
 * automatically: the mapping still holds, so the re-plan carries it (`replanOntoCurrentRows`). A member of a pair resolves under
 * its own status — the one it would have outside the pair — and its group needs the carry as well.
 */
export const V7_IMPORT_DECISION_KINDS = ["map", "withdraw", "carry"] as const;
export type V7ImportDecisionKind = (typeof V7_IMPORT_DECISION_KINDS)[number];
/** Ruled: A only (carry both, unlinked). C (treat as new) is deferred; B is rejected. */
export const V7_IMPORT_CARRY_OPTIONS = ["A"] as const;
export type V7ImportCarryOption = (typeof V7_IMPORT_CARRY_OPTIONS)[number];
export const V7_IMPORT_CARRY_LABEL: Record<V7ImportCarryOption, string> = { A: "Carry both, unlinked" };

/** The own statuses each resolution kind resolves. */
export const V7_IMPORT_DECISION_FITS: Readonly<Record<"map" | "withdraw", readonly V7ImportRowStatus[]>> = {
  map: ["new", "needs-mapping"],
  withdraw: ["withdrawn"],
};

/**
 * A row's own status: its status, or — for a member of a pair that moved — the status it would have outside the pair, read from
 * the sides it has and what moved (no side here: new; none there: withdrawn; scope or a crosswalk key moved: needs-mapping).
 */
export function v7ImportOwnStatus(row: Pick<V7ImportSummaryRow, "status" | "consoleRowId" | "v7Figure" | "changedFields">): Exclude<V7ImportRowStatus, "linked-pair-changed"> {
  if (row.status !== "linked-pair-changed") return row.status;
  if (row.consoleRowId === null) return "new";
  if (row.v7Figure === null) return "withdrawn";
  if (row.changedFields.length === 0) return "matched";
  return row.changedFields.some((field) => field === "scope" || field.startsWith("migrated_record.")) ? "needs-mapping" : "changed";
}

export type V7ImportDecision = {
  decisionId: string;
  sourceSystem: typeof V7_IMPORT_SOURCE_SYSTEM; legacyDbId: string;
  kind: V7ImportDecisionKind;
  /** map: the category, and the factor by its dataset and id. Otherwise null. */
  categoryCode: string | null; datasetId: string | null; factorId: string | null;
  /** carry: the ruled option, and the pair group it was made for. Otherwise null. */
  carryOption: V7ImportCarryOption | null; forPairGroup: string | null;
  /** The row as it stood when decided: the decision applies while the row still stands so. */
  forStatus: V7ImportRowStatus; forScope: V7ImportScope; forCode: string | null;
  /** The summary it was made against. */
  sessionId: string;
  reason: string | null; decidedBy: string; decidedAt: string;
};

/**
 * A row's own resolution against the latest summary:
 *   matched / auto-accepted — nothing to do (a changed row: the re-plan carries it);
 *   resolved   — a map or withdraw that fits the row as it stands now, and is still valid;
 *   stale      — one made when the row stood otherwise, or whose mapping no longer validates (`invalid` names why);
 *   unresolved — a row that needs a person and has no decision.
 * And, in a pair group that moved, its carry: carried (the group's decision, for this group), awaiting, or — a stored /1 summary,
 * whose pairs have no group — needs a fresh summary.
 */
export type V7ImportResolution = "matched" | "auto-accepted" | "resolved" | "stale" | "unresolved";
export type V7ImportCarryState = "carried" | "awaiting" | "needs-fresh-summary";

/** The job's verdict once its decisions are counted. Ranked: a pair outranks a mapping, which outranks a withdrawal to confirm. */
export const V7_IMPORT_RESOLVED_VERDICTS = ["clean", "ready-to-ingest", "needs-confirmation", "needs-mapping", "blocked-on-pairs"] as const;
export type V7ImportResolvedVerdict = (typeof V7_IMPORT_RESOLVED_VERDICTS)[number];

/** Whether a decision is for the row as it stands now. */
export function v7ImportDecisionFits(decision: Pick<V7ImportDecision, "kind" | "forScope" | "forCode" | "forPairGroup">,
  row: Pick<V7ImportSummaryRow, "status" | "scope" | "code" | "consoleRowId" | "v7Figure" | "changedFields" | "pairGroup">): boolean {
  if (decision.kind === "carry") return row.pairGroup !== null && decision.forPairGroup === row.pairGroup;
  return V7_IMPORT_DECISION_FITS[decision.kind].includes(v7ImportOwnStatus(row)) && decision.forScope === row.scope && decision.forCode === row.code;
}

export type V7ImportPairGroup = { pairGroup: string; members: string[]; quantityConsistent: boolean; moved: boolean; carried: boolean };

/**
 * Each row's resolution, each pair group's carry and the job's verdict. `invalid` names the mappings that no longer validate (a
 * factor retired, a membership rule changed), by decision id — such a decision does not resolve its row.
 */
export function resolveV7Import(rows: readonly V7ImportSummaryRow[], decisions: readonly V7ImportDecision[], invalid: ReadonlyMap<string, string> = new Map()): {
  rows: Array<{ legacyDbId: string; ownStatus: Exclude<V7ImportRowStatus, "linked-pair-changed">; resolution: V7ImportResolution; decision: V7ImportDecision | null;
    carry: V7ImportCarryState | null; carryDecision: V7ImportDecision | null }>;
  groups: V7ImportPairGroup[];
  verdict: V7ImportResolvedVerdict;
} {
  const key = (sourceSystem: string, legacyDbId: string) => `${sourceSystem}|${legacyDbId}`;
  const resolutions = new Map(decisions.filter((decision) => decision.kind !== "carry").map((decision) => [key(decision.sourceSystem, decision.legacyDbId), decision]));
  const carries = new Map(decisions.filter((decision) => decision.kind === "carry").map((decision) => [key(decision.sourceSystem, decision.legacyDbId), decision]));
  // A group moved when any member did; then every member needs the group's carry.
  const moved = new Set(rows.filter((row) => row.status === "linked-pair-changed" && row.pairGroup !== null).map((row) => row.pairGroup!));
  const resolved = rows.map((row) => {
    const ownStatus = v7ImportOwnStatus(row);
    const decision = resolutions.get(key(row.sourceSystem, row.legacyDbId)) ?? null;
    const resolution: V7ImportResolution = ownStatus === "matched" ? "matched"
      : ownStatus === "changed" ? "auto-accepted"
        : !decision ? "unresolved"
          : v7ImportDecisionFits(decision, row) && !invalid.has(decision.decisionId) ? "resolved" : "stale";
    const carryDecision = carries.get(key(row.sourceSystem, row.legacyDbId)) ?? null;
    const carry: V7ImportCarryState | null = row.pairGroup === null ? (row.status === "linked-pair-changed" ? "needs-fresh-summary" : null)
      : !moved.has(row.pairGroup) ? null
        : carryDecision && v7ImportDecisionFits(carryDecision, row) ? "carried" : "awaiting";
    return { legacyDbId: row.legacyDbId, ownStatus, resolution, decision, carry, carryDecision };
  });
  const groups = [...new Set(rows.map((row) => row.pairGroup).filter((group): group is string => group !== null))].map((pairGroup) => {
    const members = rows.map((row, at) => ({ row, at })).filter(({ row }) => row.pairGroup === pairGroup);
    return { pairGroup, members: members.map(({ row }) => row.legacyDbId), quantityConsistent: members[0]!.row.pairQuantityConsistent !== false,
      moved: moved.has(pairGroup), carried: members.every(({ at }) => resolved[at]!.carry !== "awaiting") };
  });
  const open = (statuses: readonly V7ImportRowStatus[]) => resolved.some((row) => statuses.includes(row.ownStatus) && row.resolution !== "resolved");
  const verdict: V7ImportResolvedVerdict = resolved.some((row) => row.carry === "awaiting" || row.carry === "needs-fresh-summary") ? "blocked-on-pairs"
    : open(["new", "needs-mapping"]) ? "needs-mapping"
      : open(["withdrawn"]) ? "needs-confirmation"
        : rows.every((row) => row.status === "matched") ? "clean" : "ready-to-ingest";
  return { rows: resolved, groups, verdict };
}

// ── The commands' input ──────────────────────────────────────────────────────────────────────────────────────────

export type V7ImportDecisionSetInput = {
  /** carry: any member names the group; the decision is written for every member of it. */
  jobId: string; sourceSystem: typeof V7_IMPORT_SOURCE_SYSTEM; legacyDbId: string; kind: V7ImportDecisionKind;
  categoryCode?: string | null; datasetId?: string | null; factorId?: string | null;
  carryOption?: V7ImportCarryOption | null;
  /** The decision this one replaces (in the same slot, for this row), or null for none; omitted, whatever is current is replaced. */
  expectedDecisionId?: string | null;
};
/** Clears the named decision — for a carry, the group's carry on every member. */
export type V7ImportDecisionClearInput = { jobId: string; sourceSystem: typeof V7_IMPORT_SOURCE_SYSTEM; legacyDbId: string; expectedDecisionId: string };

export const V7_IMPORT_DECISION_ID = /^v7-decision-[0-9a-f-]{36}$/;
const LEGACY_DB_ID = /^(source:)?[0-9A-Za-z_-]{1,64}$/;
const CATEGORY_CODE = /^[0-9](\.[0-9A-Za-z-]{1,60})?$/;
/** A dataset or factor id: a slug, never free text. Whether it names a real, active factor is the command's check. */
const FACTOR_REF = /^[0-9A-Za-z][0-9A-Za-z_.:+@/-]{0,199}$/;
const SET_KEYS = ["jobId", "sourceSystem", "legacyDbId", "kind", "categoryCode", "datasetId", "factorId", "carryOption", "expectedDecisionId"];
const CLEAR_KEYS = ["jobId", "sourceSystem", "legacyDbId", "expectedDecisionId"];

const identityIssues = (input: Record<string, unknown>, allowed: readonly string[]): CommandIssue[] => {
  const extra = Object.keys(input).filter((key) => !allowed.includes(key));
  // Closed, as the summary is: a decision carries ids, codes and enums. The unknown key is named, its value never.
  if (extra.length) return [{ field: "input", code: "UNKNOWN_FIELD", message: `A decision carries only ids, codes and its kind; it has ${extra.slice(0, 5).join(", ")}.` }];
  const issues: CommandIssue[] = [];
  if (typeof input.jobId !== "string" || !input.jobId.trim()) issues.push({ field: "jobId", code: "REQUIRED", message: "Name the job." });
  if (input.sourceSystem !== V7_IMPORT_SOURCE_SYSTEM) issues.push({ field: "sourceSystem", code: "INVALID", message: "The source system is the previous system's code." });
  if (typeof input.legacyDbId !== "string" || !LEGACY_DB_ID.test(input.legacyDbId)) issues.push({ field: "legacyDbId", code: "INVALID", message: "The record id is an id of the previous system." });
  return issues;
};

/** import.decision.set — the shape. Whether the row is in the job's latest summary, and the mapping legitimate, is the command's. */
export function v7ImportDecisionSetIssues(input: V7ImportDecisionSetInput): CommandIssue[] {
  const record = input as unknown as Record<string, unknown>;
  const issues = identityIssues(record, SET_KEYS);
  if (issues.some((issue) => issue.code === "UNKNOWN_FIELD")) return issues;
  if (!(V7_IMPORT_DECISION_KINDS as readonly unknown[]).includes(input.kind)) issues.push({ field: "kind", code: "INVALID", message: "A decision maps a row, confirms its withdrawal, or carries its pair." });
  if (input.expectedDecisionId != null && (typeof input.expectedDecisionId !== "string" || !V7_IMPORT_DECISION_ID.test(input.expectedDecisionId)))
    issues.push({ field: "expectedDecisionId", code: "INVALID", message: "The decision replaced is named by its id." });
  const given = (field: "categoryCode" | "datasetId" | "factorId" | "carryOption") => input[field] !== undefined && input[field] !== null;
  if (input.kind === "map") {
    if (typeof input.categoryCode !== "string" || !CATEGORY_CODE.test(input.categoryCode)) issues.push({ field: "categoryCode", code: "REQUIRED", message: "Choose the category the row is re-ingested under." });
    if (typeof input.datasetId !== "string" || !FACTOR_REF.test(input.datasetId) || typeof input.factorId !== "string" || !FACTOR_REF.test(input.factorId))
      issues.push({ field: "factorId", code: "REQUIRED", message: "Choose the factor the row is re-ingested with." });
    if (given("carryOption")) issues.push({ field: "carryOption", code: "NO_PAYLOAD", message: "A mapping names no carry option." });
  } else if (input.kind === "withdraw") {
    if (given("categoryCode") || given("datasetId") || given("factorId") || given("carryOption"))
      issues.push({ field: "kind", code: "NO_PAYLOAD", message: "Confirming a withdrawal names no category, factor or carry option." });
  } else if (input.kind === "carry") {
    if (!(V7_IMPORT_CARRY_OPTIONS as readonly unknown[]).includes(input.carryOption))
      issues.push({ field: "carryOption", code: "INVALID", message: "A pair carries one way: carry both, unlinked (A)." });
    if (given("categoryCode") || given("datasetId") || given("factorId"))
      issues.push({ field: "kind", code: "NO_PAYLOAD", message: "A carry names no category or factor; each member is mapped under its own status." });
  }
  return issues;
}

export function v7ImportDecisionClearIssues(input: V7ImportDecisionClearInput): CommandIssue[] {
  const issues = identityIssues(input as unknown as Record<string, unknown>, CLEAR_KEYS);
  if (issues.some((issue) => issue.code === "UNKNOWN_FIELD")) return issues;
  if (typeof input.expectedDecisionId !== "string" || !V7_IMPORT_DECISION_ID.test(input.expectedDecisionId))
    issues.push({ field: "expectedDecisionId", code: "REQUIRED", message: "Name the decision being cleared." });
  return issues;
}
