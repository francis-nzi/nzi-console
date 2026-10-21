-- 0174 Live scope rows move off variant ids: each covered `<base><suffix>` row is re-filed as its base under the pair
-- (BUILD-dataset-factor-dedup slice 5, Step C; re-ingested rows ruled out 21 Oct 2026: "Revert + re-run").
--
-- ## Why
--
-- Since Step A every write files by applicability: a new row never cites a variant id the flag-on path would leave behind. The rows
-- written before still do. Step E retires the materialised variant rows, so first every live row that can be re-filed is moved
-- onto its base — the exact transform slice 3 applies at resolution — and stops depending on them.
--
-- ## Which rows
--
-- A live, dataset-factor row, not already filed, whose factor id is a variant `<base><suffix>` that is **covered**, by the one rule
-- every write applies (`fileByApplicability`):
--   - the suffix is the row's category's own pair: the first active registry suffix (by sort order, then suffix) for the category's
--     GHG category that is in the base's **active** applicability — what slice 3 would file the base under there;
--   - the base is an active factor in the row's own dataset;
--   - the variant row is there too, at the base's **value, unit and scopes** (slice 4's fold condition: the price is unchanged).
--
-- **Never touched:**
--   - **Re-ingested rows** (`reingested_from_row_id`): attest-only (RULING-v7-reingest-row-protection), never edited in place. They
--     move by revert and re-run, which Step A files by applicability — ruled 21 Oct 2026. On staging these are J000663's 45 rows,
--     and the only live rows on variant ids at all.
--   - Migrated rows (v7 history, immutable — 0133), client-factor rows, rows already filed.
--   - A scope-shifted copy (`-bcp`): its Scope 1 base cannot stand for business travel, so it is never covered.
--   - **Frozen reports**: a snapshot carries its own copy of every factor id and value and never re-resolves; no snapshot is read or
--     written here.
--
-- ## What changes on a re-filed row
--
-- `factor_id` → the base; `filed_suffix_code` → the suffix; `factor_label` → the pair's own curated label (0172, relocated from the
-- variant identity — what the row already printed), kept as it was where the pair has none; `provenance_json.filedUnder` →
-- `{ suffixCode, by: "applicability" }`, exactly as a write records it. **Nothing priced or printed moves**: the value is the
-- variant's own (equal by 0170's guard), the report label resolves from the pair (slice 3), the factor label is the pair's. So the
-- row's version, review and attestation are left as they are — this is a change of representation, not of anything a reviewer
-- approved. One audit event per row, `scope_row.factor.refiled`, names the variant it cited and the base and pair it now carries.
--
-- Pure data, no DDL. The post-condition is re-checked rather than assumed: no row this migration could re-file is left citing a
-- variant id. NZC-120 untouched. The runner wraps this in its transaction.

CREATE TEMP TABLE migration_0174_refiled (
  organisation_id text NOT NULL,
  scope_row_id text NOT NULL,
  job_id text NOT NULL,
  variant_factor_id text NOT NULL,
  base_factor_id text NOT NULL,
  suffix_code text NOT NULL,
  factor_label_was text,
  factor_label_now text
) ON COMMIT DROP;

DO $$
DECLARE org text; refiled bigint; total bigint := 0;
BEGIN
  -- Organisation by organisation, so forced row-level security confines each statement to its own tenant whichever role applies it.
  FOR org IN SELECT organisation_id FROM nzi_console.organisations ORDER BY organisation_id LOOP
    PERFORM set_config('app.organisation_id', org, true);

    WITH candidates AS (
      SELECT r.organisation_id, r.scope_row_id, r.job_id, r.dataset_id, r.factor_id, r.factor_label, p.base, p.suffix_code,
             coalesce(nullif(btrim(r.category_code), ''), CASE WHEN r.scope ~ '^3\.\d+$' THEN r.scope END) AS category
        FROM nzi_console.job_scope_rows r
        CROSS JOIN LATERAL nzi_console.factor_id_parts(r.factor_id) p
       WHERE r.organisation_id = org
         AND r.origin = 'live' AND r.factor_source = 'dataset' AND r.factor_id IS NOT NULL
         AND r.filed_suffix_code IS NULL AND r.reingested_from_row_id IS NULL
         AND p.suffix_code IS NOT NULL
    ), covered AS (
      SELECT c.*, a.label AS pair_label
        FROM candidates c
        JOIN nzi_console.emission_factors b
          ON b.organisation_id = c.organisation_id AND b.dataset_id = c.dataset_id AND b.factor_id = c.base AND b.active
        JOIN nzi_console.emission_factors v
          ON v.organisation_id = c.organisation_id AND v.dataset_id = c.dataset_id AND v.factor_id = c.factor_id
        JOIN nzi_console.factor_identity_categories a
          ON a.organisation_id = c.organisation_id AND a.factor_id = c.base AND a.suffix_code = c.suffix_code AND a.status = 'active'
       WHERE c.category IS NOT NULL
         AND v.kgco2e_per_unit = b.kgco2e_per_unit AND v.activity_unit = b.activity_unit
         AND (SELECT array_agg(s ORDER BY s) FROM unnest(v.scopes) s) = (SELECT array_agg(s ORDER BY s) FROM unnest(b.scopes) s)
         -- The category's own pair: the suffix slice 3 would file the base under in this category.
         AND c.suffix_code = (
               SELECT reg.suffix_code
                 FROM nzi_console.factor_category_variants reg
                 JOIN nzi_console.factor_identity_categories own
                   ON own.organisation_id = c.organisation_id AND own.factor_id = c.base AND own.suffix_code = reg.suffix_code AND own.status = 'active'
                WHERE reg.status = 'active'
                  AND reg.ghg_category = CASE WHEN c.category ~ '^3\.\d+$' THEN c.category ELSE split_part(c.category, '.', 1) END
                ORDER BY reg.sort_order, reg.suffix_code
                LIMIT 1)
    )
    INSERT INTO migration_0174_refiled
    SELECT organisation_id, scope_row_id, job_id, factor_id, base, suffix_code, factor_label, coalesce(pair_label, factor_label)
      FROM covered;

    UPDATE nzi_console.job_scope_rows r
       SET factor_id = m.base_factor_id,
           filed_suffix_code = m.suffix_code,
           factor_label = m.factor_label_now,
           provenance_json = coalesce(r.provenance_json, '{}'::jsonb)
                             || jsonb_build_object('filedUnder', jsonb_build_object('suffixCode', m.suffix_code, 'by', 'applicability'))
      FROM migration_0174_refiled m
     WHERE r.organisation_id = org AND m.organisation_id = org AND r.scope_row_id = m.scope_row_id;
    GET DIAGNOSTICS refiled = ROW_COUNT;
    total := total + refiled;

    INSERT INTO nzi_console.audit_events
      (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, before_json, after_json)
    SELECT m.organisation_id, gen_random_uuid()::text, 'migration:0174', 'system', 'scope_row.factor.refiled', 'scope_row', m.scope_row_id,
           'migration:0174',
           'A live row on a category variant re-filed as its base under the pair, by applicability (BUILD-dataset-factor-dedup slice 5, Step C). Nothing priced or printed changed.',
           jsonb_build_object('jobId', m.job_id, 'factorId', m.variant_factor_id, 'filedSuffixCode', NULL, 'factorLabel', m.factor_label_was),
           jsonb_build_object('jobId', m.job_id, 'factorId', m.base_factor_id, 'filedSuffixCode', m.suffix_code, 'factorLabel', m.factor_label_now)
      FROM migration_0174_refiled m
     WHERE m.organisation_id = org;
  END LOOP;
  PERFORM set_config('app.organisation_id', '', true);
  RAISE NOTICE '0174 re-filed % live scope row(s) from a category variant id onto its base, by applicability', total;
END $$;

-- The post-condition, re-checked rather than assumed: no live row this migration could re-file still cites a variant id. Said, not
-- failed on: the rows it leaves on variant ids (re-ingested, scope-shifted, uncovered) are named by count for the deploy log.
DO $$
DECLARE org text; missed bigint; total_missed bigint := 0; left_reingested bigint; left_other bigint;
BEGIN
  FOR org IN SELECT organisation_id FROM nzi_console.organisations ORDER BY organisation_id LOOP
    PERFORM set_config('app.organisation_id', org, true);
    SELECT count(*) INTO missed
      FROM nzi_console.job_scope_rows r
      CROSS JOIN LATERAL nzi_console.factor_id_parts(r.factor_id) p
      JOIN nzi_console.emission_factors b ON b.organisation_id = r.organisation_id AND b.dataset_id = r.dataset_id AND b.factor_id = p.base AND b.active
      JOIN nzi_console.emission_factors v ON v.organisation_id = r.organisation_id AND v.dataset_id = r.dataset_id AND v.factor_id = r.factor_id
      JOIN nzi_console.factor_identity_categories a ON a.organisation_id = r.organisation_id AND a.factor_id = p.base AND a.suffix_code = p.suffix_code AND a.status = 'active'
     WHERE r.organisation_id = org AND r.origin = 'live' AND r.factor_source = 'dataset' AND r.filed_suffix_code IS NULL
       AND r.reingested_from_row_id IS NULL AND p.suffix_code IS NOT NULL
       AND coalesce(nullif(btrim(r.category_code), ''), CASE WHEN r.scope ~ '^3\.\d+$' THEN r.scope END) IS NOT NULL
       AND v.kgco2e_per_unit = b.kgco2e_per_unit AND v.activity_unit = b.activity_unit
       AND (SELECT array_agg(s ORDER BY s) FROM unnest(v.scopes) s) = (SELECT array_agg(s ORDER BY s) FROM unnest(b.scopes) s)
       AND p.suffix_code = (
             SELECT reg.suffix_code FROM nzi_console.factor_category_variants reg
               JOIN nzi_console.factor_identity_categories own
                 ON own.organisation_id = r.organisation_id AND own.factor_id = p.base AND own.suffix_code = reg.suffix_code AND own.status = 'active'
              WHERE reg.status = 'active'
                AND reg.ghg_category = CASE WHEN coalesce(nullif(btrim(r.category_code), ''), r.scope) ~ '^3\.\d+$'
                                            THEN coalesce(nullif(btrim(r.category_code), ''), r.scope)
                                            ELSE split_part(coalesce(nullif(btrim(r.category_code), ''), r.scope), '.', 1) END
              ORDER BY reg.sort_order, reg.suffix_code LIMIT 1);
    total_missed := total_missed + missed;

    SELECT count(*) FILTER (WHERE r.reingested_from_row_id IS NOT NULL), count(*) FILTER (WHERE r.reingested_from_row_id IS NULL)
      INTO left_reingested, left_other
      FROM nzi_console.job_scope_rows r CROSS JOIN LATERAL nzi_console.factor_id_parts(r.factor_id) p
     WHERE r.organisation_id = org AND r.origin = 'live' AND r.factor_source = 'dataset' AND p.suffix_code IS NOT NULL;
    IF left_reingested > 0 OR left_other > 0 THEN
      RAISE NOTICE '0174 for %: % re-ingested live row(s) left on variant ids (revert and re-run), % other(s) not covered (scope-shifted or uncovered)',
        org, left_reingested, left_other;
    END IF;
  END LOOP;
  PERFORM set_config('app.organisation_id', '', true);
  IF total_missed > 0 THEN
    RAISE EXCEPTION '0174: % live row(s) on a covered variant id were not re-filed', total_missed;
  END IF;
END $$;
