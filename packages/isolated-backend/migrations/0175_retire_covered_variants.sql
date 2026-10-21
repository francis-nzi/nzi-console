-- 0175 The materialised category variants retire: a factor's value is held once, its reuse is applicability
-- (BUILD-dataset-factor-dedup slice 5, Step E — the point of no return; J000663 ruled 21 Oct 2026: "Option 2").
--
-- ## Why
--
-- Since Step D applicability is the default for every resolution, every write and the import; Step C moved live rows off variant ids.
-- A `<base><suffix>` value row that carries its base's value, unit and scopes is now only a second copy of a number: nothing files by it
-- that would not file identically by its base under the pair. So it is withdrawn from new use — `active = false`, never deleted: the row
-- and its value stay, so anything frozen against it still reads it, and the change is reversible while this is the newest migration.
-- The code's flag-off path, which priced from these rows, is removed in the same change (REPORT_FACTOR_APPLICABILITY no longer exists).
--
-- ## Which variant rows retire
--
-- An active `<base><suffix>` row, under an active registry suffix, that is **covered** and **cited by nothing that could still use it**:
--   - covered: its base is an active factor in the same dataset at the **same value, unit and scopes**, and (base, suffix) is an **active**
--     applicability pair — the fold condition every write and the import apply;
--   - uncited: no **live** scope row (enabled or not), register source or emission group names it in its dataset; and no client alias,
--     portal bucket grant, portal record, LCA line or transport leg, client reporting-template line or input-spec rule names it.
--
-- **Kept, active:**
--   - **Scope-shifted copies** (the `-bcp` business-travel copies of Scope 1 company cars): a genuine Scope 3 claim their base cannot make
--     — distinct factors, materialised permanently (ruled with Step E).
--   - **Anything cited.** On staging that is J000663: its 45 live re-ingested rows name 15 variant rows. The revert their move needed is
--     refused (the job was snapshotted since), and they stay on their variant ids — ruled 21 Oct 2026, "Option 2". A cited variant is a
--     factor like any other and keeps pricing its rows off its own row.
--   - v7 history (migrated rows) and frozen snapshots carry their own copies and never re-resolve: they cite nothing that this changes.
--
-- ## The inert pairs retire too (ruled with Step E)
--
-- 0170 backfilled a pair for every materialised variant, the scope-shifted ones included: (company car, `-bcp`). Such a pair can never
-- file anything — no active row of its base, in any dataset, has scopes that reach the suffix's GHG category, so write validity refuses
-- it and the pick lists never offer it. Now applicability is the system of record it should say so: each is retired (status, with a
-- reason; never deleted — 0170's trigger refuses that). A pair whose base can be filed under it is untouched.
--
-- ## Record and check
--
-- One audit event per retired variant row (`emission_factor.retired`) and per retired pair (`factor.applicability.retired`), as the
-- migration. The post-condition is re-checked, not assumed: no active row is left that this rule retires, every retired row's base is
-- active, and nothing that could still use a retired row names it. NZC-120 untouched. The runner wraps this in its transaction.

CREATE TEMP TABLE migration_0175_retired (
  organisation_id text NOT NULL,
  dataset_id text NOT NULL,
  factor_id text NOT NULL,
  base_factor_id text NOT NULL,
  suffix_code text NOT NULL
) ON COMMIT DROP;

CREATE TEMP TABLE migration_0175_inert_pairs (
  organisation_id text NOT NULL,
  factor_id text NOT NULL,
  suffix_code text NOT NULL,
  ghg_category text NOT NULL
) ON COMMIT DROP;

-- Whether anything that could still use a factor id names it. Read inside each organisation's own pass (forced RLS confines it).
CREATE OR REPLACE FUNCTION pg_temp.migration_0175_cited(p_org text, p_dataset text, p_factor text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM nzi_console.job_scope_rows r
                  WHERE r.organisation_id = p_org AND r.dataset_id = p_dataset AND r.factor_id = p_factor AND r.origin = 'live')
      OR EXISTS (SELECT 1 FROM nzi_console.job_emission_sources s
                  WHERE s.organisation_id = p_org AND s.dataset_id = p_dataset AND s.factor_id = p_factor)
      OR EXISTS (SELECT 1 FROM nzi_console.job_emission_groups g
                  WHERE g.organisation_id = p_org AND g.dataset_id = p_dataset AND g.factor_id = p_factor)
      -- An alias names the factor identity (0125 re-keyed it off the dataset), so it keeps the variant in every dataset.
      OR EXISTS (SELECT 1 FROM nzi_console.client_factor_aliases a WHERE a.organisation_id = p_org AND a.factor_id = p_factor)
      OR EXISTS (SELECT 1 FROM nzi_console.portal_data_entry_bucket_grants b
                  WHERE b.organisation_id = p_org AND p_factor = ANY (b.allowed_factor_ids))
      OR EXISTS (SELECT 1 FROM nzi_console.portal_data_entry_records p WHERE p.organisation_id = p_org AND p.factor_id = p_factor)
      OR EXISTS (SELECT 1 FROM nzi_console.lca_line_items l
                  WHERE l.organisation_id = p_org AND l.dataset_id = p_dataset AND l.factor_id = p_factor)
      OR EXISTS (SELECT 1 FROM nzi_console.lca_transport_legs t
                  WHERE t.organisation_id = p_org AND t.dataset_id = p_dataset AND t.factor_id = p_factor)
      OR EXISTS (SELECT 1 FROM nzi_console.client_reporting_template_lines t
                  WHERE t.organisation_id = p_org AND t.dataset_id = p_dataset AND t.factor_id = p_factor)
      OR EXISTS (SELECT 1 FROM nzi_console.input_spec_factor_rules fr WHERE fr.active AND fr.factor_base = p_factor)
      OR EXISTS (SELECT 1 FROM nzi_console.input_spec_companion_rules cr WHERE cr.active AND cr.factor_base = p_factor)
$$;

DO $$
DECLARE org text; retired bigint; pairs bigint; total bigint := 0; total_pairs bigint := 0;
BEGIN
  FOR org IN SELECT organisation_id FROM nzi_console.organisations ORDER BY organisation_id LOOP
    PERFORM set_config('app.organisation_id', org, true);

    -- 1. The covered, uncited variant rows.
    INSERT INTO migration_0175_retired
    SELECT v.organisation_id, v.dataset_id, v.factor_id, p.base, p.suffix_code
      FROM nzi_console.emission_factors v
      CROSS JOIN LATERAL nzi_console.factor_id_parts(v.factor_id) p
      JOIN nzi_console.factor_category_variants reg ON reg.suffix_code = p.suffix_code AND reg.status = 'active'
      JOIN nzi_console.emission_factors b
        ON b.organisation_id = v.organisation_id AND b.dataset_id = v.dataset_id AND b.factor_id = p.base AND b.active
      JOIN nzi_console.factor_identity_categories a
        ON a.organisation_id = v.organisation_id AND a.factor_id = p.base AND a.suffix_code = p.suffix_code AND a.status = 'active'
     WHERE v.organisation_id = org AND v.active AND p.suffix_code IS NOT NULL
       AND v.kgco2e_per_unit = b.kgco2e_per_unit AND v.activity_unit = b.activity_unit
       AND (SELECT array_agg(s ORDER BY s) FROM unnest(v.scopes) s) = (SELECT array_agg(s ORDER BY s) FROM unnest(b.scopes) s)
       AND NOT pg_temp.migration_0175_cited(v.organisation_id, v.dataset_id, v.factor_id);

    UPDATE nzi_console.emission_factors f SET active = false
      FROM migration_0175_retired m
     WHERE f.organisation_id = org AND m.organisation_id = org AND f.dataset_id = m.dataset_id AND f.factor_id = m.factor_id;
    GET DIAGNOSTICS retired = ROW_COUNT;
    total := total + retired;

    INSERT INTO nzi_console.audit_events
      (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, before_json, after_json)
    SELECT m.organisation_id, gen_random_uuid()::text, 'migration:0175', 'system', 'emission_factor.retired', 'emission_factor',
           m.dataset_id || '/' || m.factor_id, 'migration:0175',
           'A category variant carrying its base''s value, unit and scopes, cited by nothing that could still use it: its reuse is the base''s applicability under the pair (BUILD-dataset-factor-dedup slice 5, Step E). Retired, never deleted.',
           jsonb_build_object('datasetId', m.dataset_id, 'factorId', m.factor_id, 'active', true),
           jsonb_build_object('datasetId', m.dataset_id, 'factorId', m.factor_id, 'active', false, 'base', m.base_factor_id, 'suffixCode', m.suffix_code)
      FROM migration_0175_retired m WHERE m.organisation_id = org;

    -- 2. The inert pairs: no active row of the base, in any dataset, has scopes reaching the suffix's GHG category.
    INSERT INTO migration_0175_inert_pairs
    SELECT a.organisation_id, a.factor_id, a.suffix_code, reg.ghg_category
      FROM nzi_console.factor_identity_categories a
      JOIN nzi_console.factor_category_variants reg ON reg.suffix_code = a.suffix_code
     WHERE a.organisation_id = org AND a.status = 'active'
       AND EXISTS (SELECT 1 FROM nzi_console.emission_factors b WHERE b.organisation_id = org AND b.factor_id = a.factor_id AND b.active)
       AND NOT EXISTS (
             SELECT 1 FROM nzi_console.emission_factors b, unnest(b.scopes) AS claim
              WHERE b.organisation_id = org AND b.factor_id = a.factor_id AND b.active
                AND (claim = reg.ghg_category OR reg.ghg_category LIKE claim || '.%'));

    UPDATE nzi_console.factor_identity_categories a
       SET status = 'retired', retired_at = now(), retired_by = 'migration:0175',
           retired_reason = format('Inert: no row of %s has scopes reaching %s (its category under %s), so nothing can be filed under it (BUILD-dataset-factor-dedup slice 5, Step E).',
                                   a.factor_id, i.ghg_category, a.suffix_code),
           version = a.version + 1, updated_at = now(), updated_by = 'migration:0175'
      FROM migration_0175_inert_pairs i
     WHERE a.organisation_id = org AND i.organisation_id = org AND a.factor_id = i.factor_id AND a.suffix_code = i.suffix_code;
    GET DIAGNOSTICS pairs = ROW_COUNT;
    total_pairs := total_pairs + pairs;

    INSERT INTO nzi_console.audit_events
      (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, before_json, after_json)
    SELECT i.organisation_id, gen_random_uuid()::text, 'migration:0175', 'system', 'factor.applicability.retired', 'factor_applicability',
           i.factor_id || i.suffix_code, 'migration:0175',
           'An inert applicability pair: its base can never be filed under this category (BUILD-dataset-factor-dedup slice 5, Step E).',
           jsonb_build_object('factorId', i.factor_id, 'suffixCode', i.suffix_code, 'status', 'active'),
           jsonb_build_object('factorId', i.factor_id, 'suffixCode', i.suffix_code, 'status', 'retired', 'ghgCategory', i.ghg_category)
      FROM migration_0175_inert_pairs i WHERE i.organisation_id = org;
  END LOOP;
  PERFORM set_config('app.organisation_id', '', true);
  RAISE NOTICE '0175 retired % covered category variant row(s) and % inert applicability pair(s)', total, total_pairs;
END $$;

-- The post-condition, re-checked rather than assumed.
DO $$
DECLARE org text; left_retirable bigint; orphaned bigint; cited bigint; kept_cited bigint; kept_shifted bigint;
        total_left bigint := 0; total_orphaned bigint := 0; total_cited bigint := 0;
BEGIN
  FOR org IN SELECT organisation_id FROM nzi_console.organisations ORDER BY organisation_id LOOP
    PERFORM set_config('app.organisation_id', org, true);
    -- Nothing this rule retires is left active.
    SELECT count(*) INTO left_retirable
      FROM nzi_console.emission_factors v
      CROSS JOIN LATERAL nzi_console.factor_id_parts(v.factor_id) p
      JOIN nzi_console.factor_category_variants reg ON reg.suffix_code = p.suffix_code AND reg.status = 'active'
      JOIN nzi_console.emission_factors b ON b.organisation_id = v.organisation_id AND b.dataset_id = v.dataset_id AND b.factor_id = p.base AND b.active
      JOIN nzi_console.factor_identity_categories a ON a.organisation_id = v.organisation_id AND a.factor_id = p.base AND a.suffix_code = p.suffix_code AND a.status = 'active'
     WHERE v.organisation_id = org AND v.active AND p.suffix_code IS NOT NULL
       AND v.kgco2e_per_unit = b.kgco2e_per_unit AND v.activity_unit = b.activity_unit
       AND (SELECT array_agg(s ORDER BY s) FROM unnest(v.scopes) s) = (SELECT array_agg(s ORDER BY s) FROM unnest(b.scopes) s)
       AND NOT pg_temp.migration_0175_cited(v.organisation_id, v.dataset_id, v.factor_id);
    -- Every retired row's base is active.
    SELECT count(*) INTO orphaned FROM migration_0175_retired m
     WHERE m.organisation_id = org AND NOT EXISTS (SELECT 1 FROM nzi_console.emission_factors b
             WHERE b.organisation_id = org AND b.dataset_id = m.dataset_id AND b.factor_id = m.base_factor_id AND b.active);
    -- Nothing that could still use a retired row names it.
    SELECT count(*) INTO cited FROM migration_0175_retired m
     WHERE m.organisation_id = org AND pg_temp.migration_0175_cited(org, m.dataset_id, m.factor_id);
    total_left := total_left + left_retirable; total_orphaned := total_orphaned + orphaned; total_cited := total_cited + cited;

    -- For the deploy log: what stays materialised, and why.
    SELECT count(*) FILTER (WHERE pg_temp.migration_0175_cited(v.organisation_id, v.dataset_id, v.factor_id)),
           count(*) FILTER (WHERE b.factor_id IS NOT NULL
             AND (SELECT array_agg(s ORDER BY s) FROM unnest(v.scopes) s) IS DISTINCT FROM (SELECT array_agg(s ORDER BY s) FROM unnest(b.scopes) s))
      INTO kept_cited, kept_shifted
      FROM nzi_console.emission_factors v
      CROSS JOIN LATERAL nzi_console.factor_id_parts(v.factor_id) p
      LEFT JOIN nzi_console.emission_factors b ON b.organisation_id = v.organisation_id AND b.dataset_id = v.dataset_id AND b.factor_id = p.base
     WHERE v.organisation_id = org AND v.active AND p.suffix_code IS NOT NULL;
    IF kept_cited > 0 OR kept_shifted > 0 THEN
      RAISE NOTICE '0175 for %: % variant row(s) kept because something still cites them, % kept as scope-shifted copies', org, kept_cited, kept_shifted;
    END IF;
  END LOOP;
  PERFORM set_config('app.organisation_id', '', true);
  IF total_left > 0 OR total_orphaned > 0 OR total_cited > 0 THEN
    RAISE EXCEPTION '0175: % retirable row(s) left active, % retired row(s) without an active base, % retired row(s) still cited', total_left, total_orphaned, total_cited;
  END IF;
END $$;
