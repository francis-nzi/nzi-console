import { categoriesForLevels, isCurrencyUnit, isUnfiled, parseFactorId, type CommandContext, type CommandInputMap } from "@nzi/contracts";
import { asRule, COLUMNS, listMembershipRules, pairedCategoriesLookup, type MembershipRuleRecord, type RuleRow } from "./factorMembershipRead";
import { listCategoryVariants } from "./factorCategoryVariants";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";

/**
 * Which factors a category offers (NZC-171, ruled): the map, read and curated.
 *
 * The rule of membership is `@nzi/contracts` `membersOfCategory`; this file reads the map it works from, lists what no rule claims, and is
 * how an Admin (`factor.manage`) files a family under a category - `factor.membership.add` / `.retire`, under the command runner like every
 * governed write: validation, idempotency, the audit (the rule before; the result after) and the outbox. A rule is never deleted or
 * re-pointed (the table's trigger refuses both, for every identity): it is retired, and a new one added.
 */
export type UnfiledFactor = { factorId: string; label: string; datasetId: string; sourceLevels: string[] };
export type MembershipReport = {
  rules: MembershipRuleRecord[];
  /** Physical factors no rule claims and no pair files: offered in no list until the map names their family. */
  unfiled: UnfiledFactor[];
  /** Factors whose family is deliberately held back (a rule with no category yet) - known, and listed. */
  heldBack: UnfiledFactor[];
};

/** What the admin factor screen shows: the map, what it leaves out, and what it holds back. Tenant-scoped (factors are). */
export async function membershipReport(db: Queryable, organisationId: string): Promise<MembershipReport> {
  const rules = await listMembershipRules(db, { includeRetired: true });
  const active = rules.filter((rule) => rule.status === "active");
  const registry = await listCategoryVariants(db);
  const paired = await pairedCategoriesLookup(db, organisationId, registry);
  const { rows } = await db.query<{ dataset_id: string; factor_id: string; label: string; activity_unit: string; source_levels: string[] | null }>(
    `SELECT DISTINCT ON (factor_id) dataset_id, factor_id, label, activity_unit, source_levels
       FROM nzi_console.emission_factors WHERE organisation_id = $1 AND active ORDER BY factor_id, dataset_id DESC`, [organisationId]);
  const unfiled: UnfiledFactor[] = [], heldBack: UnfiledFactor[] = [];
  const parse = (id: string) => parseFactorId(id, registry);
  for (const row of rows) {
    const levels = row.source_levels ?? [];
    const factor = { factorId: row.factor_id, activityUnit: row.activity_unit, sourceLevels: levels };
    // Only a physical, unvarianted, unpaired factor needs a family: spend follows its basis, a variant its suffix, a pair its pair.
    if (parse(row.factor_id).variant || isCurrencyUnit(row.activity_unit) || paired(parse(row.factor_id).base) !== undefined) continue;
    if (categoriesForLevels(active, levels).length > 0) continue;
    (isUnfiled(factor, active, parse, false) ? unfiled : heldBack).push({ factorId: row.factor_id, label: row.label, datasetId: row.dataset_id, sourceLevels: levels });
  }
  return { rules, unfiled, heldBack };
}

export class MembershipError extends Error {
  constructor(message: string, public readonly reason: "no-reason" | "unknown") { super(message); this.name = "MembershipError"; }
}

const sameRule = (input: { sourceL1: string; sourceL2?: string | null; sourceL3?: string | null; categoryCode?: string | null }) =>
  [input.sourceL1.trim(), input.sourceL2?.trim() ?? null, input.sourceL3?.trim() ?? null, input.categoryCode ?? null] as const;

const WHERE_SAME = `lower(btrim(regexp_replace(source_l1, '\\s+', ' ', 'g'))) = lower(btrim(regexp_replace($1, '\\s+', ' ', 'g')))
   AND coalesce(lower(btrim(regexp_replace(source_l2, '\\s+', ' ', 'g'))), '') = coalesce(lower(btrim(regexp_replace($2::text, '\\s+', ' ', 'g'))), '')
   AND coalesce(lower(btrim(regexp_replace(source_l3, '\\s+', ' ', 'g'))), '') = coalesce(lower(btrim(regexp_replace($3::text, '\\s+', ' ', 'g'))), '')
   AND coalesce(category_code, '') = coalesce($4::text, '')`;

/** File a family under a category. Idempotent; reinstates a retired rule. */
export async function addMembershipIn(db: Queryable, actorId: string, input: CommandInputMap["factor.membership.add"])
  : Promise<{ rule: MembershipRuleRecord; before: MembershipRuleRecord | null; outcome: "added" | "reinstated" | "already-filed" }> {
  const [l1, l2, l3, category] = sameRule(input);
  const found = (await db.query<RuleRow>(`SELECT ${COLUMNS} FROM nzi_console.factor_category_membership WHERE ${WHERE_SAME} FOR UPDATE`, [l1, l2, l3, category])).rows[0];
  if (found?.status === "active") return { rule: asRule(found), before: asRule(found), outcome: "already-filed" };
  if (found) {
    const { rows } = await db.query<RuleRow>(
      `UPDATE nzi_console.factor_category_membership SET status = 'active', retired_at = NULL, retired_by = NULL,
              note = COALESCE($2, note), version = version + 1, updated_at = now(), updated_by = $3
        WHERE rule_id = $1::bigint RETURNING ${COLUMNS}`, [found.rule_id, input.note?.trim() ?? null, actorId]);
    return { rule: asRule(rows[0]!), before: asRule(found), outcome: "reinstated" };
  }
  const { rows } = await db.query<RuleRow>(
    `INSERT INTO nzi_console.factor_category_membership (source_l1, source_l2, source_l3, category_code, note, source, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, 'admin', $6, $6) RETURNING ${COLUMNS}`, [l1, l2, l3, category, input.note?.trim() ?? "", actorId]);
  return { rule: asRule(rows[0]!), before: null, outcome: "added" };
}

/** Withhold a rule, keeping the record. Idempotent. */
export async function retireMembershipIn(db: Queryable, actorId: string, input: CommandInputMap["factor.membership.retire"], reason: string)
  : Promise<{ rule: MembershipRuleRecord; before: MembershipRuleRecord; alreadyRetired: boolean }> {
  if (reason.trim() === "") throw new MembershipError("A retirement states its reason.", "no-reason");
  const [l1, l2, l3, category] = sameRule(input);
  const found = (await db.query<RuleRow>(`SELECT ${COLUMNS} FROM nzi_console.factor_category_membership WHERE ${WHERE_SAME} FOR UPDATE`, [l1, l2, l3, category])).rows[0];
  if (!found) throw new MembershipError(`No rule files ${[l1, l2, l3].filter(Boolean).join(" / ")} under ${category ?? "no category"}.`, "unknown");
  if (found.status === "retired") return { rule: asRule(found), before: asRule(found), alreadyRetired: true };
  const { rows } = await db.query<RuleRow>(
    `UPDATE nzi_console.factor_category_membership SET status = 'retired', retired_at = now(), retired_by = $2,
            version = version + 1, updated_at = now(), updated_by = $2 WHERE rule_id = $1::bigint RETURNING ${COLUMNS}`, [found.rule_id, actorId]);
  return { rule: asRule(rows[0]!), before: asRule(found), alreadyRetired: false };
}

const asValidation = (error: unknown): never => {
  if (error instanceof MembershipError) {
    throw new CommandValidationError([{ field: error.reason === "no-reason" ? "reason" : "sourceL1", code: error.reason.toUpperCase().replace(/-/g, "_"), message: error.message }]);
  }
  throw error;
};

export function addMembershipCommand(pool: PoolLike, input: CommandInputMap["factor.membership.add"], context: CommandContext)
  : Promise<StoredOutcome<{ rule: MembershipRuleRecord; outcome: "added" | "reinstated" | "already-filed" }>> {
  return runPostgresCommand(pool, "factor.membership.add", input, context, async (db) => {
    const added = await addMembershipIn(db, context.actorId, input);
    return { data: { rule: added.rule, outcome: added.outcome }, entityType: "factor_category_membership", entityId: added.rule.ruleId, topic: `factor.membership.${added.outcome}`,
      ...(added.before ? { before: added.before } : {}) };
  });
}

export function retireMembershipCommand(pool: PoolLike, input: CommandInputMap["factor.membership.retire"], context: CommandContext)
  : Promise<StoredOutcome<{ rule: MembershipRuleRecord; alreadyRetired: boolean }>> {
  return runPostgresCommand(pool, "factor.membership.retire", input, context, async (db) => {
    const retired = await retireMembershipIn(db, context.actorId, input, context.reason ?? "").catch(asValidation);
    return { data: { rule: retired.rule, alreadyRetired: retired.alreadyRetired }, entityType: "factor_category_membership", entityId: retired.rule.ruleId, topic: "factor.membership.retired", before: retired.before };
  });
}
