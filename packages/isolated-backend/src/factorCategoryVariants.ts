import { randomUUID } from "node:crypto";
import { isSuffixShape, type CategoryVariant, type VariantStatus } from "@nzi/contracts";
import { withTenantRead, withTenantWrite, type PoolLike, type Queryable } from "./postgres";

/**
 * Reading and governing the category-variant registry (NZC-145).
 *
 * The registry is estate-wide: the suffix vocabulary is the same for every client, because a factor id that
 * meant one category for one tenant and another for the next would not identify anything. Reads still go
 * through a tenant context, so the connection is the same confined one every other read uses.
 *
 * ## What may change, and what may not
 *
 * A `suffix_code` and its GHG category are permanent — the migration's trigger refuses both, for every
 * identity. What these commands can do is add a variant, refine a label or description, and retire one.
 *
 * Retiring keeps the variant readable so history still resolves, and withholds it from new fan-outs. There
 * is no delete.
 */

type VariantRow = {
  suffix_code: string;
  label: string;
  ghg_category: string;
  description: string;
  status: VariantStatus;
  sort_order: number;
};

const asVariant = (row: VariantRow): CategoryVariant => ({
  suffixCode: row.suffix_code,
  label: row.label,
  ghgCategory: row.ghg_category,
  description: row.description,
  status: row.status,
  sortOrder: row.sort_order,
});

const SELECT = `SELECT suffix_code, label, ghg_category, description, status, sort_order
                  FROM nzi_console.factor_category_variants
                 ORDER BY sort_order, suffix_code`;

/**
 * The whole registry, active and retired.
 *
 * Both, always. A parser needs the retired ones or a historical factor id stops resolving; a picker needs
 * only the active ones and filters with `availableVariants`. Returning just the active set here would make
 * the second caller correct and the first silently wrong.
 */
export const listCategoryVariants = (db: Queryable): Promise<CategoryVariant[]> =>
  db.query<VariantRow>(SELECT).then(({ rows }) => rows.map(asVariant));

/** The registry on a pool, for a caller that has no transaction of its own. */
export const readCategoryVariants = (pool: PoolLike, organisationId: string): Promise<CategoryVariant[]> =>
  withTenantRead(pool, organisationId, listCategoryVariants);

/**
 * How many factors in *this organisation* carry a suffix.
 *
 * Tenant-scoped, and labelled as such wherever it is shown. It cannot be an estate-wide count: factors are
 * tenant-scoped under forced row-level security while this registry is not, so a cross-tenant total would
 * need a definer read. The permanence guard does not depend on this figure — a suffix is permanent whether
 * or not anything uses it — so the count is information for a person, never an input to a rule.
 */
export async function countVariantUse(
  db: Queryable, organisationId: string,
): Promise<ReadonlyMap<string, number>> {
  const { rows } = await db.query<{ suffix_code: string; used: string }>(
    `SELECT v.suffix_code,
            count(f.factor_id) FILTER (WHERE f.factor_id LIKE '%' || v.suffix_code)::text AS used
       FROM nzi_console.factor_category_variants v
       LEFT JOIN nzi_console.emission_factors f
         ON f.organisation_id = $1 AND f.factor_id LIKE '%' || v.suffix_code
      GROUP BY v.suffix_code`, [organisationId]);
  return new Map(rows.map((row) => [row.suffix_code, Number(row.used)]));
}

export class VariantRegistryError extends Error {
  constructor(message: string, public readonly reason: "shape" | "duplicate" | "unknown" | "retired") {
    super(message);
    this.name = "VariantRegistryError";
  }
}

const audit = (
  db: Queryable,
  entry: { organisationId: string; actorId: string; action: string; suffixCode: string; detail: Record<string, unknown> },
) => db.query(
  `INSERT INTO nzi_console.audit_events
     (organisation_id,audit_event_id,actor_id,principal_type,action,entity_type,entity_id,correlation_id,after_json)
   VALUES ($1,$2,$3,'staff',$4,'factor_category_variant',$5,$5,$6::jsonb)`,
  [entry.organisationId, `audit-${randomUUID()}`, entry.actorId, entry.action, entry.suffixCode,
    JSON.stringify(entry.detail)]);

/**
 * Add a variant, available immediately.
 *
 * Additive by construction: a new suffix cannot change what an existing one means, which is why adding is
 * an ordinary command while renaming is impossible.
 */
export async function addCategoryVariant(
  pool: PoolLike,
  input: {
    organisationId: string; actorId: string;
    suffixCode: string; label: string; ghgCategory: string; description?: string; sortOrder?: number;
  },
): Promise<CategoryVariant> {
  // Trimmed but deliberately **not** lower-cased. Silently folding `-C` into `-c` would create a
  // permanent identifier that is not the one the admin typed, and they would find out later from a
  // factor id. Refusing says so at the point of the mistake.
  const suffixCode = input.suffixCode.trim();
  if (!isSuffixShape(suffixCode)) {
    throw new VariantRegistryError(
      `A suffix is a hyphen and one to four lowercase letters: '${suffixCode}' is not.`, "shape");
  }

  return withTenantWrite(pool, input.organisationId, async (db) => {
    const existing = await db.query<VariantRow>(
      `SELECT suffix_code, label, ghg_category, description, status, sort_order
         FROM nzi_console.factor_category_variants WHERE suffix_code = $1`, [suffixCode]);
    if (existing.rows[0]) {
      // Names the status, because "already there" and "already there but retired" need different actions:
      // one is a duplicate, the other is a variant somebody meant to bring back.
      throw new VariantRegistryError(
        `The suffix ${suffixCode} is already registered (${existing.rows[0].status}) and is permanent. ` +
        `Refine its label, or register a different suffix.`, "duplicate");
    }

    const { rows } = await db.query<VariantRow>(
      `INSERT INTO nzi_console.factor_category_variants
         (suffix_code, label, ghg_category, description, sort_order, source, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,'admin',$6,$6)
       RETURNING suffix_code, label, ghg_category, description, status, sort_order`,
      [suffixCode, input.label.trim(), input.ghgCategory.trim(), input.description?.trim() ?? "",
        input.sortOrder ?? 0, input.actorId]);

    await audit(db, {
      organisationId: input.organisationId, actorId: input.actorId,
      action: "factor.variant.added", suffixCode,
      detail: { suffixCode, label: input.label.trim(), ghgCategory: input.ghgCategory.trim() },
    });
    return asVariant(rows[0]!);
  });
}

/**
 * Refine a variant's wording.
 *
 * Label and description only. The suffix and its GHG category are what the variant *is*, and the trigger
 * refuses both — so this command does not offer them rather than offering them and failing.
 */
export async function relabelCategoryVariant(
  pool: PoolLike,
  input: { organisationId: string; actorId: string; suffixCode: string; label: string; description?: string },
): Promise<CategoryVariant> {
  return withTenantWrite(pool, input.organisationId, async (db) => {
    const { rows } = await db.query<VariantRow>(
      `UPDATE nzi_console.factor_category_variants
          SET label = $2,
              description = COALESCE($3, description),
              version = version + 1, updated_at = now(), updated_by = $4
        WHERE suffix_code = $1
        RETURNING suffix_code, label, ghg_category, description, status, sort_order`,
      [input.suffixCode, input.label.trim(), input.description?.trim() ?? null, input.actorId]);
    if (!rows[0]) throw new VariantRegistryError(`No variant ${input.suffixCode}.`, "unknown");

    await audit(db, {
      organisationId: input.organisationId, actorId: input.actorId,
      action: "factor.variant.relabelled", suffixCode: input.suffixCode,
      detail: { suffixCode: input.suffixCode, label: input.label.trim() },
    });
    return asVariant(rows[0]);
  });
}

/**
 * Retire a variant: unavailable to new fan-outs, still resolvable for everything already using it.
 *
 * Idempotent — retiring a retired variant reports the state rather than failing, because the desired state
 * is the same either way.
 */
export async function retireCategoryVariant(
  pool: PoolLike,
  input: { organisationId: string; actorId: string; suffixCode: string; reason: string },
): Promise<{ variant: CategoryVariant; alreadyRetired: boolean }> {
  return withTenantWrite(pool, input.organisationId, async (db) => {
    const found = await db.query<VariantRow>(
      `SELECT suffix_code, label, ghg_category, description, status, sort_order
         FROM nzi_console.factor_category_variants WHERE suffix_code = $1 FOR UPDATE`, [input.suffixCode]);
    const current = found.rows[0];
    if (!current) throw new VariantRegistryError(`No variant ${input.suffixCode}.`, "unknown");
    if (current.status === "retired") return { variant: asVariant(current), alreadyRetired: true };

    const { rows } = await db.query<VariantRow>(
      `UPDATE nzi_console.factor_category_variants
          SET status = 'retired', retired_at = now(), retired_by = $2,
              version = version + 1, updated_at = now(), updated_by = $2
        WHERE suffix_code = $1
        RETURNING suffix_code, label, ghg_category, description, status, sort_order`,
      [input.suffixCode, input.actorId]);

    await audit(db, {
      organisationId: input.organisationId, actorId: input.actorId,
      action: "factor.variant.retired", suffixCode: input.suffixCode,
      // The reason is the part somebody reads later; a retirement with no stated reason is a change nobody
      // can review.
      detail: { suffixCode: input.suffixCode, reason: input.reason.trim() },
    });
    return { variant: asVariant(rows[0]!), alreadyRetired: false };
  });
}
