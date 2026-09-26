import type { PoolLike } from "./postgres";
import { withTenantWrite } from "./postgres";
import { SOURCE_SYSTEM, type LoadPlan } from "./v7ReferenceImport";

/**
 * Write a v7 load plan (REFERENCE_DATA_DESIGN §5). One transaction, as the application role, inside the target
 * organisation — so row-level security, the identity trigger's one-family rule and every constraint apply exactly as
 * they do to any other writer.
 *
 * Re-runnable: a dataset already loaded with the same content hash is left alone; one loaded with a different hash is
 * refused (a changed edition is a new dataset, never an overwrite). An identity already in place — curated or not — is
 * never touched.
 */

export class V7LoadRefused extends Error {}

export type LoadOutcome = {
  datasetsInserted: number; datasetsUnchanged: number;
  identitiesInserted: number; identitiesKept: number;
  factorsInserted: number;
};

const BATCH = 2000;

export async function loadV7Plan(pool: PoolLike, plan: LoadPlan): Promise<LoadOutcome> {
  if (plan.refusals.length > 0) {
    throw new V7LoadRefused(`The plan carries ${plan.refusals.length} refusal(s): ${plan.refusals.map((finding) => finding.code).join(", ")}. Nothing was written.`);
  }
  // The application role holds no privilege on organisations (0092), so existence is left to the datasets table's
  // foreign key — and its error is said plainly.
  return withTenantWrite(pool, plan.organisationId, async (db) => {
    const outcome: LoadOutcome = { datasetsInserted: 0, datasetsUnchanged: 0, identitiesInserted: 0, identitiesKept: 0, factorsInserted: 0 };
    const fresh = new Set<string>();
    for (const dataset of plan.datasets) {
      const existing = (await db.query<{ content_sha256: string | null }>(
        `SELECT content_sha256 FROM nzi_console.emission_factor_datasets WHERE organisation_id=$1 AND dataset_id=$2`,
        [plan.organisationId, dataset.datasetId])).rows[0];
      if (existing) {
        if (existing.content_sha256 === dataset.contentSha256) { outcome.datasetsUnchanged += 1; continue; }
        throw new V7LoadRefused(`${dataset.datasetId} is already loaded with different content. A changed edition is a new dataset; nothing was written.`);
      }
      await db.query(
        `INSERT INTO nzi_console.emission_factor_datasets
           (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence,synthetic,
            source_system,source_family,legacy_dataset_id,content_sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11,$12,$13,$14)`,
        [plan.organisationId, dataset.datasetId, dataset.name, dataset.version, dataset.validFrom, dataset.validTo,
          dataset.countryCode, dataset.status, dataset.sourceName, dataset.licence, SOURCE_SYSTEM, dataset.sourceFamily,
          dataset.legacyDatasetId, dataset.contentSha256]);
      fresh.add(dataset.datasetId);
      outcome.datasetsInserted += 1;
    }

    // Identities first, so the curated fields are v7's and not the trigger's fallback.
    for (let start = 0; start < plan.identities.length; start += BATCH) {
      const batch = plan.identities.slice(start, start + BATCH);
      const inserted = await db.query(
        `INSERT INTO nzi_console.factor_identities
           (organisation_id,factor_id,label,report_label,business_category,levels,source_label,source_system,source_family,
            legacy_original_id,legacy_db_id,created_by)
         SELECT $1, i.factor_id, i.label, i.report_label, i.business_category,
                ARRAY(SELECT jsonb_array_elements_text(i.levels::jsonb)), i.source_label, $2, i.source_family,
                i.legacy_original_id, i.legacy_db_id, 'import:v7'
           FROM unnest($3::text[],$4::text[],$5::text[],$6::text[],$7::text[],$8::text[],$9::text[],$10::text[],$11::text[])
             AS i(factor_id,label,report_label,business_category,levels,source_label,source_family,legacy_original_id,legacy_db_id)
         ON CONFLICT (organisation_id, factor_id) DO NOTHING
         RETURNING factor_id`,
        [plan.organisationId, SOURCE_SYSTEM,
          batch.map((row) => row.factorId), batch.map((row) => row.label), batch.map((row) => row.reportLabel),
          batch.map((row) => row.businessCategory), batch.map((row) => JSON.stringify(row.levels)),
          batch.map((row) => row.sourceLabel), batch.map((row) => row.sourceFamily),
          batch.map((row) => row.legacyOriginalId), batch.map((row) => row.legacyDbId)]);
      outcome.identitiesInserted += inserted.rows.length;
      outcome.identitiesKept += batch.length - inserted.rows.length;
    }

    const factors = plan.factors.filter((factor) => fresh.has(factor.datasetId));
    for (let start = 0; start < factors.length; start += BATCH) {
      const batch = factors.slice(start, start + BATCH);
      const inserted = await db.query(
        `INSERT INTO nzi_console.emission_factors
           (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_system,
            legacy_original_id,legacy_db_id,source_levels,source_category,ghg_unit,is_removal)
         SELECT $1, f.dataset_id, f.factor_id, f.label, f.activity_unit, f.kgco2e::numeric, ARRAY[f.scope], $2,
                f.legacy_original_id, f.legacy_db_id, ARRAY(SELECT jsonb_array_elements_text(f.levels::jsonb)),
                f.source_category, f.ghg_unit, f.is_removal
           FROM unnest($3::text[],$4::text[],$5::text[],$6::text[],$7::text[],$8::text[],$9::text[],$10::text[],$11::text[],$12::text[],$13::text[],$14::boolean[])
             AS f(dataset_id,factor_id,label,activity_unit,kgco2e,scope,legacy_original_id,legacy_db_id,levels,source_category,ghg_unit,is_removal)
         RETURNING factor_id`,
        [plan.organisationId, SOURCE_SYSTEM,
          batch.map((row) => row.datasetId), batch.map((row) => row.factorId), batch.map((row) => row.label),
          batch.map((row) => row.activityUnit), batch.map((row) => row.kgco2ePerUnit), batch.map((row) => row.scopes[0]!),
          batch.map((row) => row.legacyOriginalId), batch.map((row) => row.legacyDbId),
          batch.map((row) => JSON.stringify(row.sourceLevels)), batch.map((row) => row.sourceCategory),
          batch.map((row) => row.ghgUnit), batch.map((row) => row.isRemoval)]);
      outcome.factorsInserted += inserted.rows.length;
    }
    return outcome;
  }).catch((error: { code?: string; constraint?: string }) => {
    if (error?.code === "23503" && /organisation/.test(error.constraint ?? "")) {
      throw new V7LoadRefused(`Organisation ${plan.organisationId} does not exist; it is created by migration 0127. Nothing was written.`);
    }
    throw error;
  });
}
