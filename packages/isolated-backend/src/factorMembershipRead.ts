import { type CategoryVariant, type MembershipRule } from "@nzi/contracts";
import { loadApplicability } from "./factorApplicability";
import type { Queryable } from "./postgres";

/** The membership map, read (NZC-171). Kept apart from the commands: the pick-list read in declarativeResolution needs it, and the commands need the command runner. */
export type MembershipRuleRecord = MembershipRule & { ruleId: string; note: string; status: "active" | "retired"; source: "migration" | "admin" };

export type RuleRow = { rule_id: string; source_l1: string; source_l2: string | null; source_l3: string | null; category_code: string | null; note: string; status: "active" | "retired"; source: "migration" | "admin" };
export const COLUMNS = "rule_id::text, source_l1, source_l2, source_l3, category_code, note, status, source";
export const asRule = (row: RuleRow): MembershipRuleRecord => ({ ruleId: row.rule_id, sourceL1: row.source_l1, sourceL2: row.source_l2, sourceL3: row.source_l3,
  categoryCode: row.category_code, note: row.note, status: row.status, source: row.source });

/** The rules in force. The default is the active set; the admin read asks for every rule, retired included. */
export async function listMembershipRules(db: Queryable, options: { includeRetired?: boolean } = {}): Promise<MembershipRuleRecord[]> {
  const { rows } = await db.query<RuleRow>(
    `SELECT ${COLUMNS} FROM nzi_console.factor_category_membership ${options.includeRetired ? "" : "WHERE status = 'active'"} ORDER BY rule_id`);
  return rows.map(asRule);
}

/** The base factors an active applicability pair files, by the category codes the pair's suffix serves. */
export async function pairedCategoriesLookup(db: Queryable, organisationId: string, registry: readonly CategoryVariant[]): Promise<(baseFactorId: string) => ReadonlySet<string> | undefined> {
  const applicability = await loadApplicability(db, organisationId);
  const served = new Map(registry.filter((variant) => variant.status === "active")
    .map((variant) => [variant.suffixCode, variant.ghgCategory === "1" ? "1.company-vehicles" : variant.ghgCategory]));
  return (baseFactorId) => {
    const suffixes = applicability(baseFactorId);
    if (!suffixes || suffixes.size === 0) return undefined;
    return new Set([...suffixes].map((suffix) => served.get(suffix)).filter((code): code is string => code !== undefined));
  };
}

