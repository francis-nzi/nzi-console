import type { CommandIssue } from "./commands";
import { V7_IMPORT_SCOPES, type V7ImportScope } from "./v7ImportSummary";

/**
 * The import workbench, Phase 3 (BRIEF-v7-import-workbench-phase3; migration 0229): ingest one job. The resolved decisions are the
 * crosswalk (R-B): the job's committed plan, re-planned onto v7's current records, completed from each `map`, with each `carry`
 * let through the re-sync and each `withdraw` switched off by it — then revert → re-sync (0225) → re-plan → re-ingest, with D7
 * the hard floor (R-D). It runs on the operator's machine, which holds the one-job extract (R-A option 1); the service never
 * sees it. The rehearsal (#635) runs first and is recorded; the committed chain is the same steps, kept.
 *
 * What the console keeps of each — a rehearsal, or the ingest itself — is closed, as the summary is: ids, counts, codes and Σ
 * tCO2e per scope. No label, quantity or message text (a refusal's message can name a site), only the refusal's codes.
 */
export const V7_IMPORT_INGEST_STAGES = ["ready", "revert", "resync", "replan", "reingest"] as const;
export type V7ImportIngestStage = (typeof V7_IMPORT_INGEST_STAGES)[number];
export const V7_IMPORT_INGEST_ACTOR = "policy:v7-import";

export type V7ImportIngestTotals = Record<V7ImportScope, { v7Tco2e: number; liveTco2e: number }>;
export type V7ImportIngestCounts = {
  resync: { unchanged: number; superseded: number; added: number; withdrawn: number } | null;
  /** The plan's rows: carried from the committed plan, and filled from a `map` decision. */
  plan: { committed: number; decided: number } | null;
};

/** One rehearsal, as recorded (`import.rehearsal.record`). */
export type V7ImportRehearsalRecord = {
  /** The summary it ran against (the job's latest), and the extract both were made from. */
  sessionId: string; extractSha256: string;
  /** The fingerprint of the job's current decisions it ran with: a decision changed since makes it out of date. */
  decisionsSha256: string;
  /** The completed plan's sha256, or null when it did not get that far. */
  planSha256: string | null;
  outcome: "would-commit" | "refused";
  refusedStage: V7ImportIngestStage | null;
  refusalCodes: string[];
  counts: V7ImportIngestCounts;
  /** Σ v7 and Σ live per scope as the re-ingest's D7 reconciled them; null unless it would commit. */
  scopeTotals: V7ImportIngestTotals | null;
};
export const V7_IMPORT_REHEARSAL_KEYS = ["sessionId", "extractSha256", "decisionsSha256", "planSha256", "outcome", "refusedStage", "refusalCodes", "counts", "scopeTotals"] as const;

export type V7ImportRehearsalRecordInput = { jobId: string; rehearsal: V7ImportRehearsalRecord };
/**
 * import.ingest: the committed chain for one job. The input names what the operator saw — the summary and the decisions it
 * rehearsed — and the extract; the extract's rows travel beside the command on the operator's machine and are never stored.
 */
export type V7ImportIngestInput = { jobId: string; sessionId: string; extractSha256: string; decisionsSha256: string };

const SESSION_ID = /^v7-import-[0-9a-f-]{36}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CODE = /^[A-Z0-9_]{1,64}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) < 1e6;
const figure = (value: unknown) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 1e12;
const closed = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);

export function v7ImportRehearsalRecordIssues(input: V7ImportRehearsalRecordInput): CommandIssue[] {
  const bad = (field: string, message: string): CommandIssue[] => [{ field, code: "INVALID", message }];
  if (typeof input.jobId !== "string" || !input.jobId.trim()) return [{ field: "jobId", code: "REQUIRED", message: "Name the job." }];
  const record = input.rehearsal as unknown;
  if (!isRecord(record)) return bad("rehearsal", "A rehearsal is an object.");
  const extra = Object.keys(record).filter((key) => !(V7_IMPORT_REHEARSAL_KEYS as readonly string[]).includes(key));
  // Closed: the unknown key is named, its value never.
  if (extra.length) return [{ field: "rehearsal", code: "UNKNOWN_FIELD", message: `A rehearsal carries only its listed fields; it has ${extra.slice(0, 5).join(", ")}.` }];
  if (typeof record.sessionId !== "string" || !SESSION_ID.test(record.sessionId)) return bad("rehearsal.sessionId", "The summary is named by its session id.");
  if (typeof record.extractSha256 !== "string" || !SHA256.test(record.extractSha256) || typeof record.decisionsSha256 !== "string" || !SHA256.test(record.decisionsSha256)
    || !(record.planSha256 === null || (typeof record.planSha256 === "string" && SHA256.test(record.planSha256)))) return bad("rehearsal", "Each sha256 is 64 lower-case hex characters.");
  if (record.outcome !== "would-commit" && record.outcome !== "refused") return bad("rehearsal.outcome", "A rehearsal would commit, or was refused.");
  const refused = record.outcome === "refused";
  if (refused !== (record.refusedStage !== null) || (record.refusedStage !== null && !(V7_IMPORT_INGEST_STAGES as readonly unknown[]).includes(record.refusedStage)))
    return bad("rehearsal.refusedStage", "A refused rehearsal names the step that refused; one that would commit, none.");
  if (!Array.isArray(record.refusalCodes) || record.refusalCodes.length > 50 || record.refusalCodes.some((code) => typeof code !== "string" || !CODE.test(code)) || (record.refusalCodes.length > 0) !== refused)
    return bad("rehearsal.refusalCodes", "A refusal is named by its codes only.");
  const counts = record.counts;
  if (!isRecord(counts) || !closed(counts, ["resync", "plan"])) return bad("rehearsal.counts", "Counts are the re-sync's and the plan's.");
  if (!(counts.resync === null || (isRecord(counts.resync) && closed(counts.resync, ["unchanged", "superseded", "added", "withdrawn"]) && Object.values(counts.resync).every(count))))
    return bad("rehearsal.counts.resync", "The re-sync's counts are whole numbers.");
  if (!(counts.plan === null || (isRecord(counts.plan) && closed(counts.plan, ["committed", "decided"]) && Object.values(counts.plan).every(count))))
    return bad("rehearsal.counts.plan", "The plan's counts are whole numbers.");
  const totals = record.scopeTotals;
  if (refused ? totals !== null : !(isRecord(totals) && closed(totals, V7_IMPORT_SCOPES)
    && V7_IMPORT_SCOPES.every((scope) => isRecord(totals[scope]) && closed(totals[scope] as Record<string, unknown>, ["v7Tco2e", "liveTco2e"])
      && figure((totals[scope] as Record<string, unknown>).v7Tco2e) && figure((totals[scope] as Record<string, unknown>).liveTco2e))))
    return bad("rehearsal.scopeTotals", "A rehearsal that would commit carries both sides' Σ per scope; a refused one none.");
  return [];
}

export function v7ImportIngestIssues(input: V7ImportIngestInput): CommandIssue[] {
  const issues: CommandIssue[] = [];
  const extra = Object.keys(input).filter((key) => !["jobId", "sessionId", "extractSha256", "decisionsSha256"].includes(key));
  if (extra.length) return [{ field: "input", code: "UNKNOWN_FIELD", message: `An ingest names the job, its summary, the extract and the decisions; it has ${extra.slice(0, 5).join(", ")}.` }];
  if (typeof input.jobId !== "string" || !input.jobId.trim()) issues.push({ field: "jobId", code: "REQUIRED", message: "Name the job." });
  if (typeof input.sessionId !== "string" || !SESSION_ID.test(input.sessionId)) issues.push({ field: "sessionId", code: "INVALID", message: "The summary is named by its session id." });
  if (typeof input.extractSha256 !== "string" || !SHA256.test(input.extractSha256)) issues.push({ field: "extractSha256", code: "BAD_EXTRACT_SHA256", message: "The extract's sha256 is 64 lower-case hex characters." });
  if (typeof input.decisionsSha256 !== "string" || !SHA256.test(input.decisionsSha256)) issues.push({ field: "decisionsSha256", code: "INVALID", message: "The decisions are named by their fingerprint." });
  return issues;
}
