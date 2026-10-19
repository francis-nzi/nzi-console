import { randomUUID } from "node:crypto";
import { parseFactorId, type FactorApplicability, type VariantStatus } from "@nzi/contracts";
import { requireCapability, type StaffPrincipal } from "./auth";
import { listCategoryVariants } from "./factorCategoryVariants";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";

/**
 * A factor's applicability — the categories it may be filed under — held once for every year (BUILD-dataset-factor-dedup,
 * slice 1; migration 0170).
 *
 * Today a category is chosen by the existence of a value row: `<base>-b` is business travel because somebody materialised it, in
 * every dataset-year. This is the other half of that row, lifted off it: "this factor may be filed under 3.6", with no value,
 * no dataset and no year. Nothing reads it yet — the resolver moves to it in slice 3, behind a flag — so these are foundation:
 * the backfilled set, and the commands NZI curates it with.
 *
 * ## Curated, and allowed to exceed the source
 *
 * DESNZ ships the large-diesel-car factor under business travel, managed assets and passenger vehicles, and never under
 * commuting. The factor is the same number either way, so NZI may mark it usable under 3.7 with no new row and no new value.
 *
 * ## Gated on `factor.manage`, as the registry is
 *
 * Admin alone. A consultant's `clientfactor.manage` is a different capability over a different thing.
 *
 * ## What may change
 *
 * Applicability is added, retired, and reinstated. It is never deleted or re-pointed — the migration's trigger refuses both, for
 * every identity — because a historical row was filed under it. It belongs to a base factor: a variant id cannot carry it, since
 * `<base>-b` already *is* a category of `<base>`.
 */

type ApplicabilityRow = { factor_id: string; suffix_code: string; status: VariantStatus; source: "migration" | "admin" };

const asApplicability = (row: ApplicabilityRow): FactorApplicability => ({
  factorId: row.factor_id, suffixCode: row.suffix_code, status: row.status, source: row.source,
});

const COLUMNS = "factor_id, suffix_code, status, source";

/** Every category recorded for one factor, active and retired, in the registry's order — or for every factor when none is named. */
export async function listFactorApplicability(
  db: Queryable, organisationId: string, factorId?: string,
): Promise<FactorApplicability[]> {
  const { rows } = await db.query<ApplicabilityRow>(
    `SELECT a.factor_id, a.suffix_code, a.status, a.source
       FROM nzi_console.factor_identity_categories a
       JOIN nzi_console.factor_category_variants v ON v.suffix_code = a.suffix_code
      WHERE a.organisation_id = $1 AND ($2::text IS NULL OR a.factor_id = $2)
      ORDER BY a.factor_id, v.sort_order, a.suffix_code`, [organisationId, factorId ?? null]);
  return rows.map(asApplicability);
}

export class FactorApplicabilityError extends Error {
  constructor(
    message: string,
    public readonly reason: "variant-id" | "unknown-factor" | "unknown-suffix" | "retired-suffix" | "unknown" | "no-reason",
  ) {
    super(message);
    this.name = "FactorApplicabilityError";
  }
}

const audit = (
  db: Queryable,
  entry: { organisationId: string; actorId: string; action: string; factorId: string; suffixCode: string; detail: Record<string, unknown> },
) => db.query(
  `INSERT INTO nzi_console.audit_events
     (organisation_id,audit_event_id,actor_id,principal_type,action,entity_type,entity_id,correlation_id,after_json)
   VALUES ($1,$2,$3,'staff',$4,'factor_applicability',$5,$5,$6::jsonb)`,
  [entry.organisationId, `audit-${randomUUID()}`, entry.actorId, entry.action, `${entry.factorId}${entry.suffixCode}`,
    JSON.stringify({ factorId: entry.factorId, suffixCode: entry.suffixCode, ...entry.detail })]);

/**
 * Mark a base factor usable under a category.
 *
 * Idempotent: already applicable reports so rather than failing. A retired one is reinstated, which is what bringing a category
 * back means — the record of it was never removed.
 */
export async function addFactorApplicability(
  pool: PoolLike,
  principal: StaffPrincipal,
  input: { organisationId: string; factorId: string; suffixCode: string },
): Promise<{ applicability: FactorApplicability; outcome: "added" | "reinstated" | "already-applicable" }> {
  // First, so an unauthorised caller learns nothing about what would have been accepted.
  requireCapability(principal, "factor.manage");
  const actorId = principal.userId;
  const factorId = input.factorId.trim();
  const suffixCode = input.suffixCode.trim();

  return withTenantWrite(pool, input.organisationId, async (db) => {
    const registry = await listCategoryVariants(db);
    const variant = registry.find((entry) => entry.suffixCode === suffixCode);
    if (!variant) throw new FactorApplicabilityError(`${suffixCode} is not a registered category variant.`, "unknown-suffix");
    if (variant.status === "retired") {
      throw new FactorApplicabilityError(
        `${suffixCode} (${variant.label}) is retired in the registry, so nothing new may be filed under it.`, "retired-suffix");
    }
    // The trigger refuses this too; said here in the caller's terms, before anything is written.
    const parsed = parseFactorId(factorId, registry);
    if (parsed.variant) {
      throw new FactorApplicabilityError(
        `Applicability belongs to the base factor: ${factorId} is itself the ${parsed.variant.label} variant of ${parsed.base}.`, "variant-id");
    }
    const identity = await db.query(
      `SELECT 1 FROM nzi_console.factor_identities WHERE organisation_id = $1 AND factor_id = $2`, [input.organisationId, factorId]);
    if (!identity.rows[0]) throw new FactorApplicabilityError(`No factor ${factorId} in this organisation.`, "unknown-factor");

    const existing = (await db.query<ApplicabilityRow>(
      `SELECT ${COLUMNS} FROM nzi_console.factor_identity_categories
        WHERE organisation_id = $1 AND factor_id = $2 AND suffix_code = $3 FOR UPDATE`,
      [input.organisationId, factorId, suffixCode])).rows[0];
    if (existing?.status === "active") return { applicability: asApplicability(existing), outcome: "already-applicable" };

    const written = existing
      ? await db.query<ApplicabilityRow>(
          `UPDATE nzi_console.factor_identity_categories
              SET status = 'active', retired_at = NULL, retired_by = NULL, retired_reason = NULL,
                  version = version + 1, updated_at = now(), updated_by = $4
            WHERE organisation_id = $1 AND factor_id = $2 AND suffix_code = $3
            RETURNING ${COLUMNS}`, [input.organisationId, factorId, suffixCode, actorId])
      : await db.query<ApplicabilityRow>(
          `INSERT INTO nzi_console.factor_identity_categories
             (organisation_id, factor_id, suffix_code, source, created_by, updated_by)
           VALUES ($1, $2, $3, 'admin', $4, $4)
           RETURNING ${COLUMNS}`, [input.organisationId, factorId, suffixCode, actorId]);
    const outcome = existing ? "reinstated" : "added";
    await audit(db, {
      organisationId: input.organisationId, actorId, action: `factor.applicability.${outcome}`, factorId, suffixCode,
      detail: { ghgCategory: variant.ghgCategory },
    });
    return { applicability: asApplicability(written.rows[0]!), outcome };
  });
}

/**
 * Withhold a category from a factor's new use, keeping the record.
 *
 * Idempotent, and a reason is required: a retirement nobody can explain later is a change nobody can review.
 */
export async function retireFactorApplicability(
  pool: PoolLike,
  principal: StaffPrincipal,
  input: { organisationId: string; factorId: string; suffixCode: string; reason: string },
): Promise<{ applicability: FactorApplicability; alreadyRetired: boolean }> {
  requireCapability(principal, "factor.manage");
  const actorId = principal.userId;
  const reason = input.reason.trim();
  if (!reason) throw new FactorApplicabilityError("Say why the category is being retired.", "no-reason");

  return withTenantWrite(pool, input.organisationId, async (db) => {
    const current = (await db.query<ApplicabilityRow>(
      `SELECT ${COLUMNS} FROM nzi_console.factor_identity_categories
        WHERE organisation_id = $1 AND factor_id = $2 AND suffix_code = $3 FOR UPDATE`,
      [input.organisationId, input.factorId, input.suffixCode])).rows[0];
    if (!current) {
      throw new FactorApplicabilityError(`${input.factorId} is not recorded as applicable under ${input.suffixCode}.`, "unknown");
    }
    if (current.status === "retired") return { applicability: asApplicability(current), alreadyRetired: true };

    const { rows } = await db.query<ApplicabilityRow>(
      `UPDATE nzi_console.factor_identity_categories
          SET status = 'retired', retired_at = now(), retired_by = $4, retired_reason = $5,
              version = version + 1, updated_at = now(), updated_by = $4
        WHERE organisation_id = $1 AND factor_id = $2 AND suffix_code = $3
        RETURNING ${COLUMNS}`, [input.organisationId, input.factorId, input.suffixCode, actorId, reason]);
    await audit(db, {
      organisationId: input.organisationId, actorId, action: "factor.applicability.retired",
      factorId: input.factorId, suffixCode: input.suffixCode, detail: { reason },
    });
    return { applicability: asApplicability(rows[0]!), alreadyRetired: false };
  });
}
