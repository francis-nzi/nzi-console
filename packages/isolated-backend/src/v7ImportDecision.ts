// The import workbench, Phase 2 (BRIEF-v7-import-workbench-phase2; RULING-v7-import-pair-carry; migration 0228): resolve the rows
// Phase 1 flagged.
//
//   1. The commands (`import.decision.set` / `import.decision.clear`, import.manage) keep, per imported row of a job, one current
//      resolution — map a new or needs-mapping row to a category and factor, or confirm a withdrawn row goes off — and, for a
//      member of a linked pair that moved, one current carry (ruled: A, carry both, unlinked), written for every member of the
//      group at once. Each is keyed on the row's import identity, so it survives a fresh summary; the one it replaces is
//      superseded, never deleted. They write only to `v7_import_decisions` — never to a job's rows — and audit ids, codes and the
//      kind, never a figure.
//   2. A mapping is validated when it is saved, by the rules a data-entry pick list already applies: the category is one of
//      the taxonomy's and of the row's scope; the factor is active in an active dataset, tagged for that scope, and a member
//      of the category (NZC-171's membership map, the applicability pairs, the spend rule). The same check runs again on read,
//      so a factor retired since does not leave a row looking resolved.
//   3. The reads behind the view: a job's current decisions, its rows' resolutions, its pair groups and the verdict they give,
//      and the factors a category offers for the picker.
import { randomUUID } from "node:crypto";
import {
  emissionCategoryTaxonomy, membersOfCategory, parseFactorId, resolveV7Import, SCOPE_WIDE_NOTICE, V7_IMPORT_DECISION_FITS, V7_IMPORT_SOURCE_SYSTEM,
  V7_IMPORT_SUMMARY_FORMAT, v7ImportOwnStatus,
  type CommandContext, type CommandInputMap, type V7ImportCarryOption, type V7ImportCarryState, type V7ImportDecision, type V7ImportDecisionKind,
  type V7ImportPairGroup, type V7ImportResolution, type V7ImportResolvedVerdict, type V7ImportRowStatus, type V7ImportScope,
} from "@nzi/contracts";
import { listCategoryVariants } from "./factorCategoryVariants";
import { listMembershipRules, pairedCategoriesLookup } from "./factorMembershipRead";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import { SOURCE_SYSTEM } from "./v7ClientImport";
import { listV7ImportSessions, readV7ImportView, type V7ImportSessionSummary, type V7ImportView } from "./v7ImportSummary";

const fail = (field: string, code: string, message: string): never => { throw new CommandValidationError([{ field, code, message }]); };

// ── The mapping's validation ──────────────────────────────────────────────────────────────────────────────────────

export type V7ImportMapping = { key: string; scope: V7ImportScope; categoryCode: string; datasetId: string; factorId: string };

/**
 * Why each mapping would not stand, keyed by `key`; a mapping absent from the result is legitimate. One read of the factors
 * named, and one of the membership map, however many mappings — the save checks one, the view checks every applied one.
 */
export async function invalidV7ImportMappings(db: Queryable, organisationId: string, mappings: readonly V7ImportMapping[]): Promise<Map<string, { field: string; code: string; message: string }>> {
  const invalid = new Map<string, { field: string; code: string; message: string }>();
  if (mappings.length === 0) return invalid;
  const factors = new Map((await db.query<{ dataset_id: string; factor_id: string; label: string; activity_unit: string; scopes: string[]; source_levels: string[] | null }>(
    `SELECT f.dataset_id, f.factor_id, f.label, f.activity_unit, f.scopes, f.source_levels
       FROM nzi_console.emission_factors f JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id, d.dataset_id) = (f.organisation_id, f.dataset_id)
      WHERE f.organisation_id = $1 AND f.active AND d.status = 'active' AND (f.dataset_id, f.factor_id) IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
    [organisationId, mappings.map((m) => m.datasetId), mappings.map((m) => m.factorId)])).rows.map((row) => [`${row.dataset_id}|${row.factor_id}`, row]));
  const registry = await listCategoryVariants(db);
  const rules = await listMembershipRules(db);
  const paired = await pairedCategoriesLookup(db, organisationId, registry);
  for (const mapping of mappings) {
    const category = emissionCategoryTaxonomy.find((entry) => entry.code === mapping.categoryCode);
    const factor = factors.get(`${mapping.datasetId}|${mapping.factorId}`);
    const why = !category ? { field: "categoryCode", code: "CATEGORY_UNKNOWN", message: "That is not one of the data-entry categories." }
      : category.scope !== mapping.scope ? { field: "categoryCode", code: "CATEGORY_SCOPE", message: `${category.name} is a Scope ${category.scope} category; the row is Scope ${mapping.scope}. The scope is never moved.` }
        : !factor ? { field: "factorId", code: "FACTOR_NOT_ACTIVE", message: "That factor is not active in an active dataset." }
          : !factor.scopes.some((tag) => tag.split(".")[0] === mapping.scope) ? { field: "factorId", code: "FACTOR_NOT_IN_SCOPE", message: `'${factor.label}' is not a Scope ${mapping.scope} factor.` }
            : null;
    if (why) { invalid.set(mapping.key, why); continue; }
    // NZC-171: the category's own family, as its pick list offers it. A category with no family offers its whole scope.
    const members = membersOfCategory({ categoryCode: mapping.categoryCode, rules,
      factors: [{ factorId: factor!.factor_id, activityUnit: factor!.activity_unit, sourceLevels: factor!.source_levels ?? [] }],
      parse: (factorId) => parseFactorId(factorId, registry), pairedCategories: paired });
    if (members !== null && !members.includes(factor!.factor_id))
      invalid.set(mapping.key, { field: "factorId", code: "FACTOR_NOT_IN_CATEGORY", message: `'${factor!.label}' is not one of ${category!.name}'s factors.` });
  }
  return invalid;
}

/** The factors a category offers the picker, by the same rules the save applies; at most 500, by label. */
export async function listV7ImportFactorOptions(db: Queryable, organisationId: string, categoryCode: string): Promise<{
  options: Array<{ datasetId: string; factorId: string; label: string; unit: string; dataset: string }>; notice: string | null;
} | null> {
  const category = emissionCategoryTaxonomy.find((entry) => entry.code === categoryCode);
  if (!category) return null;
  const rows = (await db.query<{ dataset_id: string; factor_id: string; label: string; activity_unit: string; scopes: string[]; source_levels: string[] | null; dataset: string }>(
    `SELECT f.dataset_id, f.factor_id, f.label, f.activity_unit, f.scopes, f.source_levels, d.name AS dataset
       FROM nzi_console.emission_factors f JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id, d.dataset_id) = (f.organisation_id, f.dataset_id)
      WHERE f.organisation_id = $1 AND f.active AND d.status = 'active' AND EXISTS (SELECT 1 FROM unnest(f.scopes) tag WHERE split_part(tag, '.', 1) = $2)
      ORDER BY f.label, d.name, f.factor_id`, [organisationId, category.scope])).rows;
  const registry = await listCategoryVariants(db);
  const members = membersOfCategory({ categoryCode, rules: await listMembershipRules(db),
    factors: rows.map((row) => ({ factorId: row.factor_id, activityUnit: row.activity_unit, sourceLevels: row.source_levels ?? [] })),
    parse: (factorId) => parseFactorId(factorId, registry), pairedCategories: await pairedCategoriesLookup(db, organisationId, registry) });
  const offered = members === null ? rows : rows.filter((row) => members.includes(row.factor_id));
  return { options: offered.slice(0, 500).map((row) => ({ datasetId: row.dataset_id, factorId: row.factor_id, label: row.label, unit: row.activity_unit, dataset: row.dataset })),
    notice: members === null ? SCOPE_WIDE_NOTICE : null };
}

// ── The commands ──────────────────────────────────────────────────────────────────────────────────────────────────

type DecisionRow = {
  decision_id: string; job_id: string; source_system: typeof V7_IMPORT_SOURCE_SYSTEM; legacy_db_id: string; kind: V7ImportDecisionKind;
  category_code: string | null; dataset_id: string | null; factor_id: string | null; carry_option: V7ImportCarryOption | null; for_pair_group: string | null;
  for_status: V7ImportRowStatus; for_scope: V7ImportScope; for_code: string | null;
  session_id: string; reason: string | null; decided_by: string; decided_at: Date;
};
const DECISION_COLUMNS = `decision_id, job_id, source_system, legacy_db_id, kind, category_code, dataset_id, factor_id, carry_option, for_pair_group,
  for_status, for_scope, for_code, session_id, reason, decided_by, decided_at`;
const decisionOf = (row: DecisionRow): V7ImportDecision => ({
  decisionId: row.decision_id, sourceSystem: row.source_system, legacyDbId: row.legacy_db_id, kind: row.kind,
  categoryCode: row.category_code, datasetId: row.dataset_id, factorId: row.factor_id, carryOption: row.carry_option, forPairGroup: row.for_pair_group,
  forStatus: row.for_status, forScope: row.for_scope, forCode: row.for_code, sessionId: row.session_id,
  reason: row.reason, decidedBy: row.decided_by, decidedAt: row.decided_at.toISOString(),
});

type SummaryRow = {
  session_id: string; summary_format: string; legacy_db_id: string; status: V7ImportRowStatus; scope: V7ImportScope; code: string | null;
  console_row_id: string | null; v7_tco2e: string | null; changed_fields: string[]; pair_group: string | null;
};
const ownStatusOf = (row: SummaryRow) => v7ImportOwnStatus({ status: row.status, consoleRowId: row.console_row_id, v7Figure: row.v7_tco2e === null ? null : Number(row.v7_tco2e), changedFields: row.changed_fields });

/** The job, imported from the previous system, locked against a concurrent decision. */
async function lockV7Job(db: Queryable, organisationId: string, jobId: string): Promise<void> {
  const job = (await db.query<{ source_system: string | null }>(`SELECT source_system FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2`, [organisationId, jobId])).rows[0];
  if (!job) fail("jobId", "NOT_FOUND", "That job was not found.");
  if (job!.source_system !== SOURCE_SYSTEM) fail("jobId", "NOT_A_V7_JOB", "Only a job imported from the previous system has rows to resolve.");
  // One job's decisions are serialised: a carry writes every member of a group at once.
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('v7-import-decision:' || $1 || ':' || $2, 0))`, [organisationId, jobId]);
}

/** The rows of the job's latest summary, by record id (`legacyDbIds` null: all of them). */
async function latestSummaryRows(db: Queryable, organisationId: string, jobId: string, legacyDbIds: readonly string[] | null): Promise<SummaryRow[]> {
  return (await db.query<SummaryRow>(
    `SELECT r.session_id, s.summary_format, r.legacy_db_id, r.status, r.scope, r.code, r.console_row_id, r.v7_tco2e::text AS v7_tco2e, r.changed_fields, r.pair_group
       FROM nzi_console.v7_import_rows r JOIN nzi_console.v7_import_sessions s ON (s.organisation_id, s.session_id) = (r.organisation_id, r.session_id)
      WHERE r.organisation_id = $1 AND r.source_system = $3 AND ($4::text[] IS NULL OR r.legacy_db_id = ANY($4::text[]))
        AND r.session_id = (SELECT l.session_id FROM nzi_console.v7_import_sessions l WHERE l.organisation_id = $1 AND l.job_id = $2 ORDER BY l.created_at DESC, l.session_id LIMIT 1)
      ORDER BY r.ordinal`,
    [organisationId, jobId, V7_IMPORT_SOURCE_SYSTEM, legacyDbIds])).rows;
}

/** The current decisions of these rows in one slot (resolution or carry), locked. */
async function currentInSlot(db: Queryable, organisationId: string, jobId: string, legacyDbIds: readonly string[], carry: boolean): Promise<Map<string, DecisionRow>> {
  return new Map((await db.query<DecisionRow>(
    `SELECT ${DECISION_COLUMNS} FROM nzi_console.v7_import_decisions
      WHERE organisation_id = $1 AND job_id = $2 AND source_system = $3 AND legacy_db_id = ANY($4::text[]) AND (kind = 'carry') = $5 AND superseded_at IS NULL FOR UPDATE`,
    [organisationId, jobId, V7_IMPORT_SOURCE_SYSTEM, legacyDbIds, carry])).rows.map((row) => [row.legacy_db_id, row]));
}

const supersede = (db: Queryable, organisationId: string, decisionIds: readonly string[], actorId: string) =>
  db.query(`UPDATE nzi_console.v7_import_decisions SET superseded_at = now(), superseded_by = $3 WHERE organisation_id = $1 AND decision_id = ANY($2::text[]) AND superseded_at IS NULL`,
    [organisationId, decisionIds, actorId]);

type NewDecision = { legacyDbId: string; kind: V7ImportDecisionKind; categoryCode: string | null; datasetId: string | null; factorId: string | null;
  carryOption: V7ImportCarryOption | null; forPairGroup: string | null; forStatus: V7ImportRowStatus; forScope: V7ImportScope; forCode: string | null; sessionId: string; supersedes: string | null };
async function insertDecision(db: Queryable, context: CommandContext, jobId: string, decision: NewDecision): Promise<string> {
  const decisionId = `v7-decision-${randomUUID()}`;
  await db.query(
    `INSERT INTO nzi_console.v7_import_decisions (organisation_id, decision_id, job_id, source_system, legacy_db_id, kind, category_code, dataset_id, factor_id,
       carry_option, for_pair_group, for_status, for_scope, for_code, session_id, supersedes_decision_id, reason, decided_by, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [context.organisationId, decisionId, jobId, V7_IMPORT_SOURCE_SYSTEM, decision.legacyDbId, decision.kind, decision.categoryCode, decision.datasetId, decision.factorId,
      decision.carryOption, decision.forPairGroup, decision.forStatus, decision.forScope, decision.forCode, decision.sessionId, decision.supersedes,
      context.reason?.trim() || null, context.actorId, context.correlationId]);
  return decisionId;
}

/** What the audit holds of a decision: ids, codes and the kind — never a figure. */
const audited = (decision: Pick<DecisionRow, "decision_id" | "legacy_db_id" | "kind" | "category_code" | "dataset_id" | "factor_id" | "carry_option" | "for_pair_group">) =>
  ({ decisionId: decision.decision_id, legacyDbId: decision.legacy_db_id, kind: decision.kind, categoryCode: decision.category_code, datasetId: decision.dataset_id,
    factorId: decision.factor_id, carryOption: decision.carry_option, pairGroup: decision.for_pair_group });

export type V7ImportDecisionResult = {
  decisionId: string | null; jobId: string; sourceSystem: typeof V7_IMPORT_SOURCE_SYSTEM; legacyDbId: string;
  kind: V7ImportDecisionKind | null; categoryCode: string | null; datasetId: string | null; factorId: string | null;
  carryOption: V7ImportCarryOption | null; pairGroup: string | null;
  /** A carry: every member of the group it was written (or cleared) for. Otherwise the one row. */
  members: string[];
  superseded: string[];
};

type DecisionCommandResult = { data: V7ImportDecisionResult; entityType: string; entityId: string; topic: string; before?: Record<string, unknown> };

/** import.decision.set — save or replace one row's resolution, or carry its pair group. */
export function setV7ImportDecision(pool: PoolLike, input: CommandInputMap["import.decision.set"], context: CommandContext): Promise<StoredOutcome<V7ImportDecisionResult>> {
  return runPostgresCommand(pool, "import.decision.set", input, context, async (db): Promise<DecisionCommandResult> => {
    const org = context.organisationId;
    await lockV7Job(db, org, input.jobId);
    const row = (await latestSummaryRows(db, org, input.jobId, [input.legacyDbId]))[0];
    if (!row) fail("legacyDbId", "NOT_IN_SUMMARY", "That record is not in the job's latest import summary.");
    const base = { jobId: input.jobId, sourceSystem: V7_IMPORT_SOURCE_SYSTEM, legacyDbId: input.legacyDbId } as const;

    if (input.kind === "carry") return carry(db, context, input, row!, base);

    // A resolution, for the row's own status (a pair member's is the one it has outside the pair).
    const own = ownStatusOf(row!);
    if (!V7_IMPORT_DECISION_FITS[input.kind].includes(own)) {
      if (own === "matched" || own === "changed") fail("kind", "NOTHING_TO_RESOLVE", "This row needs no decision: the re-plan carries it as it stands.");
      fail("kind", "KIND_DOES_NOT_FIT", input.kind === "map" ? "Only a new or needs-mapping row is mapped." : "Only a withdrawn row is confirmed off.");
    }
    const current = (await currentInSlot(db, org, input.jobId, [input.legacyDbId], false)).get(input.legacyDbId) ?? null;
    if (input.expectedDecisionId !== undefined && (current?.decision_id ?? null) !== input.expectedDecisionId)
      fail("expectedDecisionId", "DECISION_MOVED", "The row's decision changed since this screen was loaded; reload and decide again.");
    const map = input.kind === "map";
    const payload = { categoryCode: map ? input.categoryCode! : null, datasetId: map ? input.datasetId! : null, factorId: map ? input.factorId! : null };
    if (map) {
      const issue = (await invalidV7ImportMappings(db, org, [{ key: "it", scope: row!.scope, categoryCode: payload.categoryCode!, datasetId: payload.datasetId!, factorId: payload.factorId! }])).get("it");
      if (issue) throw new CommandValidationError([issue]);
    }
    if (current && current.kind === input.kind && current.category_code === payload.categoryCode && current.dataset_id === payload.datasetId && current.factor_id === payload.factorId
      && current.for_status === own && current.for_scope === row!.scope && current.for_code === row!.code)
      fail("kind", "UNCHANGED", "The row already has this decision.");
    if (current) await supersede(db, org, [current.decision_id], context.actorId);
    const decisionId = await insertDecision(db, context, input.jobId, { legacyDbId: input.legacyDbId, kind: input.kind, ...payload, carryOption: null, forPairGroup: null,
      forStatus: own, forScope: row!.scope, forCode: row!.code, sessionId: row!.session_id, supersedes: current?.decision_id ?? null });
    return {
      data: { decisionId, ...base, kind: input.kind, ...payload, carryOption: null, pairGroup: null, members: [input.legacyDbId], superseded: current ? [current.decision_id] : [] },
      entityType: "job", entityId: input.jobId, topic: "import.decision.set",
      ...(current ? { before: audited(current) } : {}),
    };
  });
}

/** The carry (RULING-v7-import-pair-carry, A only): written for every member of the row's pair group, against that group. */
async function carry(db: Queryable, context: CommandContext, input: CommandInputMap["import.decision.set"], row: SummaryRow,
  base: { jobId: string; sourceSystem: typeof V7_IMPORT_SOURCE_SYSTEM; legacyDbId: string }): Promise<DecisionCommandResult> {
  const org = context.organisationId;
  if (row.pair_group === null) {
    if (row.status === "linked-pair-changed" && row.summary_format !== V7_IMPORT_SUMMARY_FORMAT)
      fail("legacyDbId", "SUMMARY_TOO_OLD", "This summary predates pair groups; make and upload a fresh one, then carry the pair.");
    fail("kind", "NOT_A_PAIR", "Only a member of a linked pair is carried.");
  }
  const members = (await latestSummaryRows(db, org, input.jobId, null)).filter((member) => member.pair_group === row.pair_group);
  if (!members.some((member) => member.status === "linked-pair-changed")) fail("kind", "NOTHING_TO_RESOLVE", "No member of this pair moved: it carries as it stands.");
  const ids = members.map((member) => member.legacy_db_id);
  const current = await currentInSlot(db, org, input.jobId, ids, true);
  const named = current.get(input.legacyDbId)?.decision_id ?? null;
  if (input.expectedDecisionId !== undefined && named !== input.expectedDecisionId)
    fail("expectedDecisionId", "DECISION_MOVED", "The pair's carry changed since this screen was loaded; reload and decide again.");
  const already = (member: SummaryRow) => { const held = current.get(member.legacy_db_id); return held && held.carry_option === input.carryOption && held.for_pair_group === row.pair_group; };
  if (members.every(already)) fail("kind", "UNCHANGED", "The pair already carries this way.");
  const superseded = [...current.values()].map((held) => held.decision_id);
  if (superseded.length) await supersede(db, org, superseded, context.actorId);
  let decisionId: string | null = null;
  for (const member of members) {
    const id = await insertDecision(db, context, input.jobId, { legacyDbId: member.legacy_db_id, kind: "carry", categoryCode: null, datasetId: null, factorId: null,
      carryOption: input.carryOption!, forPairGroup: row.pair_group, forStatus: member.status, forScope: member.scope, forCode: member.code,
      sessionId: member.session_id, supersedes: current.get(member.legacy_db_id)?.decision_id ?? null });
    if (member.legacy_db_id === input.legacyDbId) decisionId = id;
  }
  return {
    data: { decisionId, ...base, kind: "carry" as const, categoryCode: null, datasetId: null, factorId: null, carryOption: input.carryOption!, pairGroup: row.pair_group,
      members: ids, superseded },
    entityType: "job", entityId: input.jobId, topic: "import.decision.set",
    ...(superseded.length ? { before: { carriedMembers: [...current.keys()], pairGroup: row.pair_group } } : {}),
  };
}

/** import.decision.clear — return a row to unresolved (or a pair group to uncarried); the decision is superseded, and kept. */
export function clearV7ImportDecision(pool: PoolLike, input: CommandInputMap["import.decision.clear"], context: CommandContext): Promise<StoredOutcome<V7ImportDecisionResult>> {
  return runPostgresCommand(pool, "import.decision.clear", input, context, async (db) => {
    const org = context.organisationId;
    // The row need not be in the latest summary to clear its decision: a decision outlives the summary it was made against.
    await lockV7Job(db, org, input.jobId);
    const held = (await db.query<DecisionRow>(
      `SELECT ${DECISION_COLUMNS} FROM nzi_console.v7_import_decisions
        WHERE organisation_id = $1 AND job_id = $2 AND source_system = $3 AND legacy_db_id = $4 AND superseded_at IS NULL FOR UPDATE`,
      [org, input.jobId, input.sourceSystem, input.legacyDbId])).rows;
    if (held.length === 0) fail("legacyDbId", "NO_DECISION", "That row has no decision to clear.");
    const named = held.find((decision) => decision.decision_id === input.expectedDecisionId);
    if (!named) fail("expectedDecisionId", "DECISION_MOVED", "The row's decision changed since this screen was loaded; reload and decide again.");
    // A carry is the group's: cleared on every member carrying it, so no member is left carried alone.
    const cleared = named!.kind !== "carry" ? [named!]
      : (await db.query<DecisionRow>(`SELECT ${DECISION_COLUMNS} FROM nzi_console.v7_import_decisions
          WHERE organisation_id = $1 AND job_id = $2 AND kind = 'carry' AND for_pair_group = $3 AND superseded_at IS NULL FOR UPDATE`,
        [org, input.jobId, named!.for_pair_group])).rows;
    await supersede(db, org, cleared.map((decision) => decision.decision_id), context.actorId);
    return {
      data: { decisionId: null, jobId: input.jobId, sourceSystem: V7_IMPORT_SOURCE_SYSTEM, legacyDbId: input.legacyDbId, kind: null,
        categoryCode: null, datasetId: null, factorId: null, carryOption: null, pairGroup: named!.for_pair_group,
        members: cleared.map((decision) => decision.legacy_db_id), superseded: cleared.map((decision) => decision.decision_id) },
      entityType: "job", entityId: input.jobId, topic: "import.decision.cleared", before: audited(named!),
    };
  });
}

// ── The reads behind the view ─────────────────────────────────────────────────────────────────────────────────────

/** Every job's current decisions (or one job's), keyed by job. */
export async function currentDecisions(db: Queryable, jobId: string | null): Promise<Map<string, V7ImportDecision[]>> {
  const rows = (await db.query<DecisionRow>(
    `SELECT ${DECISION_COLUMNS} FROM nzi_console.v7_import_decisions WHERE superseded_at IS NULL AND ($1::text IS NULL OR job_id = $1) ORDER BY job_id, legacy_db_id, kind`, [jobId])).rows;
  const byJob = new Map<string, V7ImportDecision[]>();
  for (const row of rows) byJob.set(row.job_id, [...(byJob.get(row.job_id) ?? []), decisionOf(row)]);
  return byJob;
}

/** The applied mappings that no longer validate, by decision id. */
export async function invalidApplied(db: Queryable, organisationId: string, decisions: readonly V7ImportDecision[]): Promise<Map<string, string>> {
  const mappings = decisions.filter((decision) => decision.kind === "map")
    .map((decision) => ({ key: decision.decisionId, scope: decision.forScope, categoryCode: decision.categoryCode!, datasetId: decision.datasetId!, factorId: decision.factorId! }));
  return new Map([...(await invalidV7ImportMappings(db, organisationId, mappings))].map(([key, issue]) => [key, issue.message]));
}

export type V7ImportRowResolution = {
  legacyDbId: string; ownStatus: Exclude<V7ImportRowStatus, "linked-pair-changed">; resolution: V7ImportResolution; decision: V7ImportDecision | null; invalid: string | null;
  carry: V7ImportCarryState | null; carryDecision: V7ImportDecision | null;
};
export type V7ImportWorkbenchView = V7ImportView & {
  decisions: V7ImportDecision[]; resolutions: V7ImportRowResolution[]; groups: V7ImportPairGroup[]; resolvedVerdict: V7ImportResolvedVerdict;
};

/** One job's latest summary, its current decisions and what they resolve, or null when the job has no summary. */
export async function readV7ImportWorkbench(db: Queryable, organisationId: string, jobId: string): Promise<V7ImportWorkbenchView | null> {
  const view = await readV7ImportView(db, jobId);
  if (!view) return null;
  const decisions = (await currentDecisions(db, jobId)).get(jobId) ?? [];
  const invalid = await invalidApplied(db, organisationId, decisions);
  const resolved = resolveV7Import(view.rows, decisions, invalid);
  return { ...view, decisions, groups: resolved.groups, resolvedVerdict: resolved.verdict,
    resolutions: resolved.rows.map((row) => ({ ...row, invalid: row.decision ? invalid.get(row.decision.decisionId) ?? null : null })) };
}

export type V7ImportWorkbenchSession = V7ImportSessionSummary & { resolvedVerdict: V7ImportResolvedVerdict; resolved: number; toResolve: number };

/** Every job with a summary — its latest — and the verdict its decisions give. */
export async function listV7ImportWorkbench(db: Queryable, organisationId: string): Promise<V7ImportWorkbenchSession[]> {
  const sessions = await listV7ImportSessions(db);
  if (sessions.length === 0) return [];
  const decisions = await currentDecisions(db, null);
  const invalid = await invalidApplied(db, organisationId, [...decisions.values()].flat());
  const rows = (await db.query<{ session_id: string; source_system: typeof V7_IMPORT_SOURCE_SYSTEM; legacy_db_id: string; status: V7ImportRowStatus; scope: V7ImportScope;
    code: string | null; console_row_id: string | null; v7_tco2e: string | null; changed_fields: string[]; pair_ref: string | null; pair_group: string | null; pair_quantity_consistent: boolean | null }>(
    `SELECT session_id, source_system, legacy_db_id, status, scope, code, console_row_id, v7_tco2e::text AS v7_tco2e, changed_fields, pair_ref, pair_group, pair_quantity_consistent
       FROM nzi_console.v7_import_rows WHERE session_id = ANY($1::text[]) ORDER BY session_id, ordinal`,
    [sessions.map((session) => session.sessionId)])).rows;
  return sessions.map((session) => {
    const own = rows.filter((row) => row.session_id === session.sessionId)
      .map((row) => ({ sourceSystem: row.source_system, legacyDbId: row.legacy_db_id, status: row.status, scope: row.scope, code: row.code,
        consoleScope: null, v7Figure: row.v7_tco2e === null ? null : Number(row.v7_tco2e), consoleFigure: null, v7Enabled: null, consoleEnabled: null,
        consoleRowId: row.console_row_id, pairRef: row.pair_ref, changedFields: row.changed_fields, pairGroup: row.pair_group, pairQuantityConsistent: row.pair_quantity_consistent }));
    const resolved = resolveV7Import(own, decisions.get(session.jobId) ?? [], invalid);
    // A row needs a person when its own status does, or its pair does; it is settled when both are done.
    const needing = resolved.rows.filter((row) => row.resolution === "resolved" || row.resolution === "stale" || row.resolution === "unresolved" || row.carry !== null);
    const settled = (row: (typeof needing)[number]) => (row.resolution === "matched" || row.resolution === "auto-accepted" || row.resolution === "resolved") && (row.carry === null || row.carry === "carried");
    return { ...session, resolvedVerdict: resolved.verdict, resolved: needing.filter(settled).length, toResolve: needing.length };
  });
}
