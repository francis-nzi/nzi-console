// The import workbench, Phase 1 (BRIEF-v7-import-workbench-phase1; migration 0226): see each job's import state.
//
//   1. The emitter (`summariseV7JobForImport`) runs where the extract is read — the operator's machine (diff-at-the-edge,
//      provisional R-A). It reads the job's current migrated rows, read-only, and compares each against v7's record now by the
//      loader's own comparison (`differs` over `migratedRowCols`, exactly as the re-sync does), and the crosswalk keys the
//      rehearsal's re-plan uses (`CROSSWALK_KEYS`). It writes nothing, and its output carries ids, codes, statuses and tCO2e —
//      never a label, a name, a quantity or an activity row (the contract's closed shape, enforced again on upload).
//   2. The upload (`import.summary.upload`, import.manage) stores that summary against the job: the system principal from the
//      operator's script, or an admin. It is validated whole — one job, the sha, the shape, totals that follow from the rows —
//      and changes nothing on the job.
//   3. The reads behind the import view: every job's latest summary, and one job's rows.
import { createHash, randomUUID } from "node:crypto";
import {
  deriveV7ImportTotals, V7_IMPORT_SCOPES, V7_IMPORT_SOURCE_SYSTEM, V7_IMPORT_SUMMARY_FORMAT,
  type CommandContext, type CommandInputMap, type V7ImportCounts, type V7ImportRowStatus, type V7ImportScope,
  type V7ImportScopeTotals, type V7ImportSummary, type V7ImportSummaryRow, type V7ImportVerdict,
} from "@nzi/contracts";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import { differs, migratedRowCols } from "./v7ClientLoad";
import { SOURCE_SYSTEM, type PlannedRow } from "./v7ClientImport";
import { CROSSWALK_KEYS } from "./v7ResyncRehearsal";

export const V7_IMPORT_ACTOR = "policy:v7-import";
export const V7_IMPORT_SESSION_PATTERN = /^v7-import-[0-9a-f-]{36}$/;

const fail = (field: string, code: string, message: string): never => { throw new CommandValidationError([{ field, code, message }]); };

type ConsoleRow = { scope_row_id: string; job_id: string; legacy_db_id: string; scope: string; enabled: boolean; linked_row_id: string | null; record: Record<string, unknown> }
  & Partial<Record<(typeof LABEL_COLUMNS)[number], string | null>>;

/** The row's label columns: what the server-side read (R-1) compares through the label rule. */
const LABEL_COLUMNS = ["source_label", "report_label", "level_1", "level_2", "level_3", "level_4", "column_text"] as const;
/** Each label column's planned field — so the refresh can carry the console's own label where the rule explains the difference. */
export const V7_IMPORT_LABEL_FIELDS = {
  source_label: "sourceLabel", report_label: "reportLabel", level_1: "level1", level_2: "level2", level_3: "level3", level_4: "level4", column_text: "columnText",
} as const satisfies Record<(typeof LABEL_COLUMNS)[number], keyof PlannedRow>;
const PLANNED_LABEL: Record<(typeof LABEL_COLUMNS)[number], (row: PlannedRow) => string | null> = {
  source_label: (row) => row.sourceLabel, report_label: (row) => row.reportLabel, level_1: (row) => row.level1, level_2: (row) => row.level2,
  level_3: (row) => row.level3, level_4: (row) => row.level4, column_text: (row) => row.columnText,
};

/**
 * The server-side read (BRIEF-v7-import-server-side, R-1): the previous system's labels arrive through the label rule, so the
 * console's own stored label is compared both as it is and as the rule makes it — a label that would come out the same is the
 * same. Given only by the view reader (`summariseV7JobFromViews`); without it, every column compares as it always has.
 */
export type V7ImportLabelComparison = { sanitise: (legacyDbId: string, value: string | null) => string | null };

/** JSON with keys in order: jsonb reorders an object's keys, so a stored record and a planned one compare by content. */
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`
    : JSON.stringify(value ?? null);
const figure = (value: unknown) => Math.round(Number(value ?? 0) * 1e6) / 1e6;
const topScope = (scope: string): V7ImportScope => {
  const digit = scope.split(".")[0];
  if (!(V7_IMPORT_SCOPES as readonly string[]).includes(digit ?? "")) fail("rows", "UNKNOWN_SCOPE", `A row's scope is not 1, 2 or 3 (${scope}).`);
  return digit as V7ImportScope;
};
const codeOf = (record: Record<string, unknown>) => {
  const code = record.original_id;
  return typeof code === "string" && /^[0-9A-Za-z_.:-]{1,64}$/.test(code) ? code : null;
};

/**
 * The emitter: one job's reconciliation summary, read-only. `rows` are the importer's planned rows of this job from a
 * one-job extract (`planV7ClientImport`), as the re-sync takes them.
 */
export async function summariseV7JobForImport(db: Queryable, input: {
  organisationId: string; jobId: string; legacyJobNumber: string; extractSha256: string; rows: readonly PlannedRow[]; generatedAt?: string;
  labels?: V7ImportLabelComparison;
}): Promise<V7ImportSummary> {
  const org = input.organisationId;
  const job = (await db.query<{ source_system: string | null; legacy_job_number: string | null }>(
    `SELECT source_system, legacy_job_number FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2`, [org, input.jobId])).rows[0];
  if (!job) fail("jobId", "NOT_FOUND", "That job was not found.");
  if (job!.source_system !== SOURCE_SYSTEM) fail("jobId", "NOT_A_V7_JOB", "Only a job imported from the previous system has an import summary.");
  if (job!.legacy_job_number !== input.legacyJobNumber) fail("legacyJobNumber", "JOB_MISMATCH", `The job is ${job!.legacy_job_number ?? "unnumbered"}, not ${input.legacyJobNumber}.`);
  const ids = input.rows.map((row) => row.legacyDbId);
  const repeated = ids.filter((id, at) => ids.indexOf(id) !== at);
  if (repeated.length) fail("rows", "ROW_REPEATED", `${new Set(repeated).size} record(s) are given more than once.`);

  // The job's current migrated rows, and any current row carrying one of these identities on another job (R5 of the re-sync).
  const select = `SELECT scope_row_id, job_id, legacy_db_id, scope, enabled, linked_row_id, migrated_record AS record${input.labels ? `, ${LABEL_COLUMNS.join(", ")}` : ""} FROM nzi_console.job_scope_rows`;
  const ofJob = (await db.query<ConsoleRow>(`${select} WHERE organisation_id = $1 AND job_id = $2 AND origin = 'migrated' AND superseded_by_row_id IS NULL ORDER BY scope_row_id`,
    [org, input.jobId])).rows;
  const elsewhere = (await db.query<ConsoleRow>(`${select} WHERE organisation_id = $1 AND source_system = $2 AND legacy_db_id = ANY($3::text[]) AND superseded_by_row_id IS NULL AND job_id <> $4`,
    [org, SOURCE_SYSTEM, ids, input.jobId])).rows;
  if (elsewhere.length) fail("rows", "ROW_OF_ANOTHER_JOB", `${elsewhere.length} record(s) are current on another job (${elsewhere.slice(0, 5).map((row) => row.scope_row_id).join(", ")}).`);
  const byIdentity = new Map(ofJob.map((row) => [row.legacy_db_id, row]));
  // The re-sync's pairing rule: a row names its partner, or is named by one.
  const pointedAt = new Map(ofJob.filter((row) => row.linked_row_id !== null).map((row) => [row.linked_row_id!, row.scope_row_id]));
  const pairOf = (row: ConsoleRow) => row.linked_row_id ?? pointedAt.get(row.scope_row_id) ?? null;
  // /2 (RULING-v7-import-pair-carry): the pair group is the shared T&D row a parent points to (the previous system's own model,
  // many parents → one T&D row), on either side; the T&D row is its own group's key. Read from the extract and the console alike,
  // so a pair new in the extract is grouped too.
  const extractParents = new Map<string, PlannedRow[]>();
  for (const planned of input.rows) if (planned.linkedRowId !== null) extractParents.set(planned.linkedRowId, [...(extractParents.get(planned.linkedRowId) ?? []), planned]);
  const groupOfPlanned = (planned: PlannedRow, was: ConsoleRow | undefined) => planned.linkedRowId
    ?? (extractParents.has(planned.scopeRowId) ? planned.scopeRowId : null) ?? (was ? was.linked_row_id ?? (pointedAt.has(was.scope_row_id) ? was.scope_row_id : null) : null);
  const groupOfConsole = (row: ConsoleRow) => row.linked_row_id ?? (pointedAt.has(row.scope_row_id) || extractParents.has(row.scope_row_id) ? row.scope_row_id : null);
  // The group's T&D quantity against its enabled parents' apportioned quantities, in the extract (the previous system's own sum,
  // `_recompute_td_row_totals`). Computed here, on the operator's machine; only the boolean leaves it.
  const plannedById = new Map(input.rows.map((planned) => [planned.scopeRowId, planned]));
  const qtyOf = (planned: PlannedRow) => Number((planned.migratedRecord as unknown as Record<string, unknown>).qty ?? 0);
  const pctOf = (planned: PlannedRow) => { const raw = (planned.migratedRecord as unknown as Record<string, unknown>).apply_pct; return raw === null || raw === undefined ? 100 : Number(raw); };
  const consistent = (group: string) => {
    const head = plannedById.get(group);
    const sum = (extractParents.get(group) ?? []).filter((parent) => parent.enabled).reduce((total, parent) => total + qtyOf(parent) * pctOf(parent) / 100, 0);
    const held = head && head.enabled ? qtyOf(head) : 0;
    return Math.abs(held - sum) <= Math.max(1e-6, Math.abs(sum) * 1e-6);
  };
  const paired = (group: string | null, partner: string | null, self: string) => group === null ? { pairRef: null, pairGroup: null, pairQuantityConsistent: null }
    : { pairRef: partner ?? (group !== self ? group : extractParents.get(group)?.[0]?.scopeRowId ?? pointedAt.get(group) ?? group), pairGroup: group, pairQuantityConsistent: consistent(group) };

  const rows: V7ImportSummaryRow[] = [];
  const consoleSide = (row: ConsoleRow) => ({ consoleScope: topScope(row.scope), consoleFigure: figure(row.record.reported_tco2e), consoleEnabled: row.enabled, consoleRowId: row.scope_row_id });
  for (const planned of input.rows) {
    const record = planned.migratedRecord as unknown as Record<string, unknown>;
    const v7Side = { code: codeOf(record), scope: planned.scope, v7Figure: figure(record.reported_tco2e), v7Enabled: planned.enabled };
    const was = byIdentity.get(planned.legacyDbId);
    const pair = paired(groupOfPlanned(planned, was), planned.linkedRowId ?? (was ? pairOf(was) : null), planned.scopeRowId);
    if (!was) {
      rows.push({ sourceSystem: V7_IMPORT_SOURCE_SYSTEM, legacyDbId: planned.legacyDbId, status: pair.pairGroup !== null ? "linked-pair-changed" : "new",
        ...v7Side, consoleScope: null, consoleFigure: null, consoleEnabled: null, consoleRowId: null, changedFields: [], ...pair });
      continue;
    }
    const labels = input.labels;
    const cols = migratedRowCols(input.jobId, planned).map((col) => labels && (LABEL_COLUMNS as readonly string[]).includes(col.column) ? { ...col, compare: false } : col);
    const found = (await differs(db, "job_scope_rows", "organisation_id=$1 AND scope_row_id=$2", [org, was.scope_row_id], cols)) ?? [];
    if (labels) {
      for (const column of LABEL_COLUMNS) {
        const held = was[column] ?? null, now = PLANNED_LABEL[column](planned);
        if (held !== now && labels.sanitise(planned.legacyDbId, held) !== now) found.push(column);
      }
    }
    const keyed = [...(topScope(was.scope) === planned.scope ? [] : ["scope"]),
      ...CROSSWALK_KEYS.filter((key) => stable(was.record[key]) !== stable(record[key])).map((key) => `migrated_record.${key}`)];
    const status: V7ImportRowStatus = found.length === 0 ? "matched"
      : pair.pairGroup !== null ? "linked-pair-changed"
        : keyed.length ? "needs-mapping" : "changed";
    rows.push({ sourceSystem: V7_IMPORT_SOURCE_SYSTEM, legacyDbId: planned.legacyDbId, status, ...v7Side, ...consoleSide(was),
      changedFields: found.length ? [...new Set([...found, ...keyed])].sort() : [], ...pair });
  }
  // Gone from v7: a row still on in the console. One already off has nothing to change (as the re-sync).
  const given = new Set(ids);
  for (const row of ofJob) {
    if (given.has(row.legacy_db_id) || !row.enabled) continue;
    const pair = paired(groupOfConsole(row), pairOf(row), row.scope_row_id);
    rows.push({ sourceSystem: V7_IMPORT_SOURCE_SYSTEM, legacyDbId: row.legacy_db_id, status: pair.pairGroup !== null ? "linked-pair-changed" : "withdrawn",
      code: null, scope: topScope(row.scope), v7Figure: null, v7Enabled: null, ...consoleSide(row), changedFields: [], ...pair });
  }
  return { format: V7_IMPORT_SUMMARY_FORMAT, jobId: input.jobId, legacyJobNumber: input.legacyJobNumber, extractSha256: input.extractSha256,
    generatedAt: input.generatedAt ?? new Date().toISOString(), rows, ...deriveV7ImportTotals(rows) };
}

/** The summary's own fingerprint: the same summary is stored once per job. */
export const v7ImportSummarySha256 = (summary: V7ImportSummary) => createHash("sha256").update(stable(summary)).digest("hex");

export type V7ImportUploadResult = { sessionId: string; jobId: string; rows: number; counts: V7ImportCounts; verdict: V7ImportVerdict };

/** import.summary.upload — store one job's summary. Counts and verdict in the result (and so the audit); no figure, no label. */
export function uploadV7ImportSummary(pool: PoolLike, input: CommandInputMap["import.summary.upload"], context: CommandContext): Promise<StoredOutcome<V7ImportUploadResult>> {
  return runPostgresCommand(pool, "import.summary.upload", input, context, async (db) => {
    const org = context.organisationId, summary = input.summary;
    const job = (await db.query<{ source_system: string | null; legacy_job_number: string | null }>(
      `SELECT source_system, legacy_job_number FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2`, [org, input.jobId])).rows[0];
    if (!job) fail("jobId", "NOT_FOUND", "That job was not found.");
    if (job!.source_system !== SOURCE_SYSTEM) fail("jobId", "NOT_A_V7_JOB", "Only a job imported from the previous system has an import summary.");
    if (job!.legacy_job_number !== summary.legacyJobNumber) fail("summary.legacyJobNumber", "JOB_MISMATCH", `The summary is of ${summary.legacyJobNumber}; this job is ${job!.legacy_job_number ?? "unnumbered"}.`);
    const sessionId = await storeV7ImportSession(db, context, input.jobId, summary);
    const { counts, verdict } = summary;
    return { data: { sessionId, jobId: input.jobId, rows: summary.rows.length, counts, verdict }, entityType: "job", entityId: input.jobId, topic: "import.summary.uploaded" };
  });
}

/**
 * Store one job's summary and its rows, inside the caller's command transaction: the upload's, or a refresh commit's (the
 * summary it ran from, read server-side). The same summary is stored once per job.
 */
export async function storeV7ImportSession(db: Queryable, context: CommandContext, jobId: string, summary: V7ImportSummary): Promise<string> {
  const org = context.organisationId;
  const summarySha = v7ImportSummarySha256(summary);
  if ((await db.query(`SELECT 1 FROM nzi_console.v7_import_sessions WHERE organisation_id = $1 AND job_id = $2 AND summary_sha256 = $3`, [org, jobId, summarySha])).rows.length)
    fail("summary", "ALREADY_UPLOADED", "This summary is already stored for this job.");
  const sessionId = `v7-import-${randomUUID()}`;
  const { counts, scopeTotals, verdict } = summary;
  await db.query(
    `INSERT INTO nzi_console.v7_import_sessions (organisation_id, session_id, job_id, legacy_job_number, extract_sha256, summary_sha256, generated_at,
       rows_matched, rows_changed, rows_needs_mapping, rows_new, rows_withdrawn, rows_linked_pair_changed,
       console_scope1_tco2e, console_scope2_tco2e, console_scope3_tco2e, v7_scope1_tco2e, v7_scope2_tco2e, v7_scope3_tco2e, verdict, created_by, correlation_id, summary_format)
     VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
    [org, sessionId, jobId, summary.legacyJobNumber, summary.extractSha256, summarySha, summary.generatedAt,
      counts.matched, counts.changed, counts.needsMapping, counts.new, counts.withdrawn, counts.linkedPairChanged,
      scopeTotals["1"].consoleTco2e, scopeTotals["2"].consoleTco2e, scopeTotals["3"].consoleTco2e, scopeTotals["1"].v7Tco2e, scopeTotals["2"].v7Tco2e, scopeTotals["3"].v7Tco2e,
      verdict, context.actorId, context.correlationId, summary.format]);
  await db.query(
    `INSERT INTO nzi_console.v7_import_rows (organisation_id, session_id, ordinal, source_system, legacy_db_id, status, code, scope, console_scope,
       v7_tco2e, console_tco2e, v7_enabled, console_enabled, console_row_id, pair_ref, changed_fields, pair_group, pair_quantity_consistent)
     SELECT $1, $2, r.ordinal, r.source_system, r.legacy_db_id, r.status, r.code, r.scope, r.console_scope,
            r.v7_tco2e, r.console_tco2e, r.v7_enabled, r.console_enabled, r.console_row_id, r.pair_ref, ARRAY(SELECT jsonb_array_elements_text(r.changed_fields)),
            r.pair_group, r.pair_quantity_consistent
       FROM jsonb_to_recordset($3::jsonb) AS r(ordinal integer, source_system text, legacy_db_id text, status text, code text, scope text, console_scope text,
            v7_tco2e numeric, console_tco2e numeric, v7_enabled boolean, console_enabled boolean, console_row_id text, pair_ref text, changed_fields jsonb,
            pair_group text, pair_quantity_consistent boolean)`,
    [org, sessionId, JSON.stringify(summary.rows.map((row, ordinal) => ({
      ordinal, source_system: row.sourceSystem, legacy_db_id: row.legacyDbId, status: row.status, code: row.code, scope: row.scope, console_scope: row.consoleScope,
      v7_tco2e: row.v7Figure, console_tco2e: row.consoleFigure, v7_enabled: row.v7Enabled, console_enabled: row.consoleEnabled,
      console_row_id: row.consoleRowId, pair_ref: row.pairRef, changed_fields: row.changedFields,
      pair_group: row.pairGroup, pair_quantity_consistent: row.pairQuantityConsistent })))]);
  return sessionId;
}

// ── The reads behind the import view ──────────────────────────────────────────────────────────────────────────────

export type V7ImportSessionSummary = {
  sessionId: string; jobId: string; jobNumber: string; legacyJobNumber: string; extractSha256: string; generatedAt: string;
  uploadedAt: string; uploadedBy: string; counts: V7ImportCounts; scopeTotals: V7ImportScopeTotals; verdict: V7ImportVerdict;
  /** The summary's format: a /1 one, stored before /2, has no pair groups — its pairs wait on a fresh summary. */
  format: string;
};
export type V7ImportView = { session: V7ImportSessionSummary; rows: V7ImportSummaryRow[]; earlierSessions: number };

type SessionRow = {
  session_id: string; job_id: string; job_number: string; legacy_job_number: string; extract_sha256: string; generated_at: Date; created_at: Date; created_by: string;
  rows_matched: number; rows_changed: number; rows_needs_mapping: number; rows_new: number; rows_withdrawn: number; rows_linked_pair_changed: number;
  console_scope1_tco2e: string; console_scope2_tco2e: string; console_scope3_tco2e: string; v7_scope1_tco2e: string; v7_scope2_tco2e: string; v7_scope3_tco2e: string;
  verdict: V7ImportVerdict; summary_format: string; console_rows_1: number; console_rows_2: number; console_rows_3: number; v7_rows_1: number; v7_rows_2: number; v7_rows_3: number;
};
const SESSION_SELECT = `SELECT s.session_id, s.job_id, j.job_number, s.legacy_job_number, s.extract_sha256, s.generated_at, s.created_at, s.created_by,
    s.rows_matched, s.rows_changed, s.rows_needs_mapping, s.rows_new, s.rows_withdrawn, s.rows_linked_pair_changed,
    s.console_scope1_tco2e, s.console_scope2_tco2e, s.console_scope3_tco2e, s.v7_scope1_tco2e, s.v7_scope2_tco2e, s.v7_scope3_tco2e, s.verdict, s.summary_format,
    ${V7_IMPORT_SCOPES.map((scope) => `(SELECT count(*)::int FROM nzi_console.v7_import_rows r WHERE (r.organisation_id, r.session_id) = (s.organisation_id, s.session_id) AND r.console_enabled AND r.console_scope = '${scope}') AS console_rows_${scope},
    (SELECT count(*)::int FROM nzi_console.v7_import_rows r WHERE (r.organisation_id, r.session_id) = (s.organisation_id, s.session_id) AND r.v7_enabled AND r.scope = '${scope}') AS v7_rows_${scope}`).join(",\n    ")}
  FROM nzi_console.v7_import_sessions s JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (s.organisation_id, s.job_id)`;

const sessionOf = (row: SessionRow): V7ImportSessionSummary => ({
  sessionId: row.session_id, jobId: row.job_id, jobNumber: row.job_number, legacyJobNumber: row.legacy_job_number, extractSha256: row.extract_sha256,
  generatedAt: row.generated_at.toISOString(), uploadedAt: row.created_at.toISOString(), uploadedBy: row.created_by,
  counts: { matched: row.rows_matched, changed: row.rows_changed, needsMapping: row.rows_needs_mapping, new: row.rows_new, withdrawn: row.rows_withdrawn, linkedPairChanged: row.rows_linked_pair_changed },
  scopeTotals: {
    "1": { consoleRows: row.console_rows_1, consoleTco2e: Number(row.console_scope1_tco2e), v7Rows: row.v7_rows_1, v7Tco2e: Number(row.v7_scope1_tco2e) },
    "2": { consoleRows: row.console_rows_2, consoleTco2e: Number(row.console_scope2_tco2e), v7Rows: row.v7_rows_2, v7Tco2e: Number(row.v7_scope2_tco2e) },
    "3": { consoleRows: row.console_rows_3, consoleTco2e: Number(row.console_scope3_tco2e), v7Rows: row.v7_rows_3, v7Tco2e: Number(row.v7_scope3_tco2e) },
  },
  verdict: row.verdict, format: row.summary_format,
});

/** Every job with a summary: its latest one, newest first. */
export async function listV7ImportSessions(db: Queryable): Promise<V7ImportSessionSummary[]> {
  return (await db.query<SessionRow>(`${SESSION_SELECT}
    WHERE s.created_at = (SELECT max(l.created_at) FROM nzi_console.v7_import_sessions l WHERE (l.organisation_id, l.job_id) = (s.organisation_id, s.job_id))
    ORDER BY s.created_at DESC, s.session_id`)).rows.map(sessionOf);
}

/** One job's latest summary and its rows (in the emitter's order), or null when the job has none. */
export async function readV7ImportView(db: Queryable, jobId: string): Promise<V7ImportView | null> {
  const sessions = (await db.query<SessionRow>(`${SESSION_SELECT} WHERE s.job_id = $1 ORDER BY s.created_at DESC, s.session_id`, [jobId])).rows;
  const latest = sessions[0];
  if (!latest) return null;
  const rows = (await db.query<{ source_system: typeof V7_IMPORT_SOURCE_SYSTEM; legacy_db_id: string; status: V7ImportRowStatus; code: string | null; scope: V7ImportScope;
    console_scope: V7ImportScope | null; v7_tco2e: string | null; console_tco2e: string | null; v7_enabled: boolean | null; console_enabled: boolean | null;
    console_row_id: string | null; pair_ref: string | null; changed_fields: string[]; pair_group: string | null; pair_quantity_consistent: boolean | null }>(
    `SELECT source_system, legacy_db_id, status, code, scope, console_scope, v7_tco2e, console_tco2e, v7_enabled, console_enabled, console_row_id, pair_ref, changed_fields,
            pair_group, pair_quantity_consistent
       FROM nzi_console.v7_import_rows WHERE session_id = $1 ORDER BY ordinal`, [latest.session_id])).rows;
  return {
    session: sessionOf(latest), earlierSessions: sessions.length - 1,
    rows: rows.map((row) => ({ sourceSystem: row.source_system, legacyDbId: row.legacy_db_id, status: row.status, code: row.code, scope: row.scope, consoleScope: row.console_scope,
      v7Figure: row.v7_tco2e === null ? null : Number(row.v7_tco2e), consoleFigure: row.console_tco2e === null ? null : Number(row.console_tco2e),
      v7Enabled: row.v7_enabled, consoleEnabled: row.console_enabled, consoleRowId: row.console_row_id, pairRef: row.pair_ref, changedFields: row.changed_fields,
      pairGroup: row.pair_group, pairQuantityConsistent: row.pair_quantity_consistent })),
  };
}
