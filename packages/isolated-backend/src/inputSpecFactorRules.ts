import type { FactorRule } from "@nzi/contracts";
import type { Queryable } from "./postgres";

/**
 * Reading a category's declared factor rules (NZC-149).
 *
 * Kept beside `inputSpecRecords` rather than inside it, because the two answer different questions and
 * are read at different moments: the spec says what the form looks like and is needed to render it, the
 * rules say which factor an entry resolves to and are needed when something has been captured. Loading
 * the mapping to draw an empty form would be work nobody asked for.
 *
 * The rows are shaped into the discriminated union the resolver takes, here, so that the shape the
 * database enforces and the shape the code branches on cannot drift apart without this failing.
 */

type Row = {
  category_code: string;
  rule_key: string;
  ordering: number;
  rule_kind: string;
  factor_base: string;
  basis_field_key: string | null;
  basis_value: string | null;
  suffix_code: string | null;
  enrichment_source: string | null;
  enrichment_key_field: string | null;
};

/**
 * One row as a rule, or `null` when the row does not satisfy the kind it claims.
 *
 * The migration's CHECK makes such a row impossible, and this still refuses to invent the missing half.
 * The alternative — defaulting `basisFieldKey` to `""` to satisfy the type — would turn a constraint
 * violation into a rule that silently never matches, which is the harder thing to notice of the two.
 */
function toRule(row: Row): FactorRule | null {
  const common = { ruleKey: row.rule_key, ordering: row.ordering, factorBase: row.factor_base };
  switch (row.rule_kind) {
    case "lookup":
      return { kind: "lookup", ...common };
    case "basis-branch":
      return row.basis_field_key && row.basis_value
        ? { kind: "basis-branch", ...common, basisFieldKey: row.basis_field_key, basisValue: row.basis_value }
        : null;
    case "suffix-variant":
      return row.suffix_code ? { kind: "suffix-variant", ...common, suffixCode: row.suffix_code } : null;
    case "enriched":
      return row.enrichment_source && row.enrichment_key_field && row.basis_field_key && row.basis_value
        ? {
          kind: "enriched", ...common,
          enrichmentSource: row.enrichment_source, enrichmentKeyField: row.enrichment_key_field,
          basisFieldKey: row.basis_field_key, basisValue: row.basis_value,
        }
        : null;
    default:
      return null;
  }
}

const SELECT = `SELECT category_code, rule_key, ordering, rule_kind, factor_base,
                       basis_field_key, basis_value, suffix_code,
                       enrichment_source, enrichment_key_field
                  FROM nzi_console.input_spec_factor_rules
                 WHERE active`;

/** Every active rule, grouped by category. Categories with no rules are simply absent. */
export async function listFactorRules(db: Queryable): Promise<Map<string, FactorRule[]>> {
  const result = await db.query<Row>(`${SELECT} ORDER BY category_code, ordering, rule_key`);
  const byCategory = new Map<string, FactorRule[]>();
  for (const row of result.rows) {
    const rule = toRule(row);
    if (!rule) continue;
    const existing = byCategory.get(row.category_code);
    if (existing) existing.push(rule);
    else byCategory.set(row.category_code, [rule]);
  }
  return byCategory;
}

/** One category's rules, in evaluation order. An empty array means the free search is the mapping. */
export async function factorRulesFor(db: Queryable, categoryCode: string): Promise<FactorRule[]> {
  const result = await db.query<Row>(
    `${SELECT} AND category_code = $1 ORDER BY ordering, rule_key`, [categoryCode]);
  return result.rows.map(toRule).filter((rule): rule is FactorRule => rule !== null);
}
