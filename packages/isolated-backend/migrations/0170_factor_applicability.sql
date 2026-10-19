-- 0170 A factor's applicability, held once — and a variant carries its base's value by construction (BUILD-dataset-factor-dedup,
-- slice 1; Direction A, approved 19 Oct 2026).
--
-- ## Why
--
-- Category reuse is materialised as value rows: `<base>-b` is the business-travel copy of `<base>`, re-created for every
-- dataset-year (0110). Two facts with different lifetimes share that row — *applicability* ("this factor may be filed under
-- 3.6"), which barely changes, and the *value*, which changes every year. And the rule that holds the scheme together — every
-- variant carries its base's kgCO2e per unit (0110: "a variant that had a different value would not be a variant") — has been a
-- convention, never a constraint.
--
-- This slice is foundation only. It adds the applicability mapping, backfills it from the variants that exist, and turns the
-- convention into a guard. No read path changes and no resolved factor changes: the resolver and the importer move in slices 3
-- and 4.
--
-- ## What this adds
--
-- 1. `factor_id_parts(factor_id)`: the registry parser, in SQL. The same rule as `parseFactorId` (contracts `factorVariants.ts`) —
--    a suffix is a suffix only because the registry holds it, the longest registered suffix wins, and an id that *is* a suffix
--    has no base. Never a last-hyphen split: `diesel-demo` is its own base. A test holds the two parsers to the same answers.
-- 2. **The value-equality guard.** Within one dataset, a base and every variant of it carry one value and one activity unit. A
--    statement trigger on `emission_factors`, so a base and its variants corrected together in one statement pass and a lone
--    divergent write is refused — for every identity, the owner included, as 0110's permanence guard is. It locks each touched
--    (organisation, dataset) for the rest of the transaction before it reads, so two concurrent writers cannot each pass alone.
--    Values in *different* datasets are independent (a 2024 value and a 2025 value differ, correctly), and a factor whose id
--    merely ends in something hyphenated (`diesel-demo`) or that is a genuinely different number with its own id (well-to-tank,
--    per-distance) is not a variant and is never compared.
-- 3. **The freight `-d` correction, ruled 19 Oct 2026.** On the v7 library, 856 downstream-freight variants (`-d`) of the DESNZ
--    van and HGV freight factors, km and tonne.km, 2019–2024, carry the **per-mile** factor's value in place of their base's —
--    `uk-ghg-27_303_3081_4_1-d` (km) and `…_14_1-d` (tonne.km) both 0.24716, which is `…_9_1` (miles). 2025 and 2026 carry the
--    base's value; the miles variants always do. DESNZ ships no downstream factor at all — the `-d` row is NZI's copy of the base
--    (DEEP-DIVE §6b) — so the base's value is the right one, and the guard could not be added over rows that break it.
--    This corrects each to its base, one audit event per value. It refuses unless every divergent variant is exactly that defect
--    (a `-d` in km or tonne.km, its unit its base's, its value its per-mile sibling's) **and** nothing names it: no scope row,
--    emission source or client alias. Any other divergence, or one in use, stops the migration and names the rows: correcting a
--    number something has been priced on is a ruling of its own, not a side effect of this one.
-- 4. `factor_identity_categories`: the categories a factor **may** be filed under — (organisation, factor, suffix), a child of
--    `factor_identities`, naming the registry's suffix. No value, no dataset, no year. NZI-curated, so it may exceed the source
--    (commuting addable where DESNZ ships none). Forced RLS and `tenant_isolation`; the app may read, add and retire; DELETE is
--    revoked and a trigger refuses it — and any re-pointing — for every identity. Applicability belongs to a base: a variant id
--    cannot carry it. Written by `factor.manage` (Admin), as the registry is.
-- 5. **The backfill**: every `<base><suffix>` value row implies (base, suffix), read through `factor_id_parts`. After the
--    correction every such pair is same-value reuse, which is exactly what applicability means.
--
-- ## What it does not change
--
-- No resolved factor: nothing names a corrected row (refused otherwise), and the resolver does not read the new table yet.
-- Issued reports carry their frozen factor ids and values and never re-resolve. The registry keeps its vocabulary and its
-- guards. `client_factors` is a later, separate follow-on. NZC-120 untouched: no money, no personal data. The runner wraps this
-- in its transaction.

-- ── 1. The registry parser, in SQL ────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION nzi_console.factor_id_parts(p_factor_id text)
RETURNS TABLE (base text, suffix_code text)
LANGUAGE sql STABLE SET search_path = nzi_console, pg_temp AS $$
  SELECT CASE WHEN s.suffix_code IS NULL THEN p_factor_id
              ELSE left(p_factor_id, length(p_factor_id) - length(s.suffix_code)) END,
         s.suffix_code
    FROM (SELECT 1) AS one
    LEFT JOIN LATERAL (
      SELECT r.suffix_code
        FROM nzi_console.factor_category_variants r
       WHERE length(p_factor_id) > length(r.suffix_code)
         AND right(p_factor_id, length(r.suffix_code)) = r.suffix_code
       ORDER BY length(r.suffix_code) DESC, r.suffix_code
       LIMIT 1) AS s ON true
$$;
COMMENT ON FUNCTION nzi_console.factor_id_parts(text) IS
  'A factor id split into its base and its registered suffix (NULL when it carries none) — the rule of parseFactorId: registered suffixes only, longest first, never the whole id. Retired suffixes still parse, so history stays readable.';

-- ── 2. The value-equality guard ───────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION nzi_console.emission_factor_variant_carries_base_value()
RETURNS trigger
LANGUAGE plpgsql SET search_path = nzi_console, pg_temp AS $$
DECLARE
  scope record;
  offending record;
BEGIN
  -- Serialise writers per (organisation, dataset) before reading: a base and a divergent variant written by two transactions at
  -- once would each pass alone. In a sorted order, so two writers cannot deadlock on it. Held until the transaction ends.
  FOR scope IN SELECT DISTINCT organisation_id, dataset_id FROM new_rows ORDER BY organisation_id, dataset_id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'nzi_console.emission_factor_variant_value/' || scope.organisation_id || '/' || scope.dataset_id, 0));
  END LOOP;

  -- Every base a written row belongs to, and every member of that base in the same dataset: the base itself and each id that
  -- parses back to it. The organisation is named, not left to row-level security, so the check is the same for every identity.
  SELECT t.organisation_id, t.dataset_id, t.base,
         string_agg(format('%s = %s per %s', f.factor_id, f.kgco2e_per_unit, f.activity_unit), '; ' ORDER BY f.factor_id) AS members
    INTO offending
    FROM (SELECT DISTINCT n.organisation_id, n.dataset_id, p.base
            FROM new_rows n CROSS JOIN LATERAL nzi_console.factor_id_parts(n.factor_id) p) AS t
    JOIN nzi_console.emission_factors f
      ON f.organisation_id = t.organisation_id
     AND f.dataset_id = t.dataset_id
     AND f.factor_id = ANY (ARRAY(SELECT t.base || r.suffix_code FROM nzi_console.factor_category_variants r) || t.base)
    CROSS JOIN LATERAL nzi_console.factor_id_parts(f.factor_id) AS fp
   WHERE f.factor_id = t.base OR fp.base = t.base
   GROUP BY t.organisation_id, t.dataset_id, t.base
  HAVING count(DISTINCT f.kgco2e_per_unit) > 1 OR count(DISTINCT f.activity_unit) > 1
   ORDER BY t.organisation_id, t.dataset_id, t.base
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      CONSTRAINT = 'emission_factor_variant_carries_base_value',
      MESSAGE = format('A category variant carries its base''s value: in dataset %s (%s), %s and its variants disagree — %s.',
                       offending.dataset_id, offending.organisation_id, offending.base, offending.members),
      HINT = 'A variant records which category a factor is used under, never a different number (0110). Change a base and its variants together, in one statement; a different number is a different factor with its own id.';
  END IF;
  RETURN NULL;
END $$;
COMMENT ON FUNCTION nzi_console.emission_factor_variant_carries_base_value() IS
  'Refuses a write that leaves a base factor and any of its registered-suffix variants in one dataset with different values or activity units. Statement-level, so a base and its variants changed together pass; for every identity, the owner included.';

-- Two triggers, because a trigger with a transition table serves one event.
CREATE TRIGGER emission_factor_variant_value_on_insert
  AFTER INSERT ON nzi_console.emission_factors
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION nzi_console.emission_factor_variant_carries_base_value();
CREATE TRIGGER emission_factor_variant_value_on_update
  AFTER UPDATE ON nzi_console.emission_factors
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION nzi_console.emission_factor_variant_carries_base_value();

-- ── 3. The freight -d correction (ruled 19 Oct 2026) ─────────────────────────────────────────────────────────

CREATE TEMP TABLE migration_0170_divergent (
  organisation_id text NOT NULL,
  dataset_id text NOT NULL,
  factor_id text NOT NULL,
  base text NOT NULL,
  suffix_code text NOT NULL,
  value numeric NOT NULL,
  unit text NOT NULL,
  base_value numeric NOT NULL,
  base_unit text NOT NULL,
  is_the_freight_defect boolean NOT NULL,
  named_by text
) ON COMMIT DROP;

DO $$
DECLARE org text;
BEGIN
  -- Organisation by organisation, so forced row-level security confines each read to its own tenant whichever role applies this.
  FOR org IN SELECT organisation_id FROM nzi_console.organisations ORDER BY organisation_id LOOP
    PERFORM set_config('app.organisation_id', org, true);

    INSERT INTO migration_0170_divergent
    SELECT v.organisation_id, v.dataset_id, v.factor_id, p.base, p.suffix_code, v.kgco2e_per_unit, v.activity_unit,
           b.kgco2e_per_unit, b.activity_unit,
           -- The defect as characterised: a downstream variant in km or tonne.km, in its base's unit, whose value is its per-mile
           -- sibling's (the same factor code with the unit segment 9, miles) in the same dataset.
           p.suffix_code = '-d' AND v.activity_unit = b.activity_unit AND v.activity_unit IN ('km', 'tonne.km')
             AND EXISTS (SELECT 1 FROM nzi_console.emission_factors m
                          WHERE m.organisation_id = v.organisation_id AND m.dataset_id = v.dataset_id
                            AND m.activity_unit = 'miles'
                            AND m.factor_id = regexp_replace(p.base, '^(.*_)[0-9]+(_[0-9]+)$', E'\\19\\2')
                            AND m.kgco2e_per_unit = v.kgco2e_per_unit),
           NULL
      FROM nzi_console.emission_factors v
      CROSS JOIN LATERAL nzi_console.factor_id_parts(v.factor_id) p
      JOIN nzi_console.emission_factors b
        ON b.organisation_id = v.organisation_id AND b.dataset_id = v.dataset_id AND b.factor_id = p.base
     WHERE v.organisation_id = org AND p.suffix_code IS NOT NULL
       AND (v.kgco2e_per_unit <> b.kgco2e_per_unit OR v.activity_unit <> b.activity_unit);

    -- Anything that names a divergent row: correcting it would move a number something has been priced on.
    UPDATE migration_0170_divergent d
       SET named_by = concat_ws(', ',
             CASE WHEN EXISTS (SELECT 1 FROM nzi_console.job_scope_rows r
                                WHERE r.organisation_id = d.organisation_id AND r.dataset_id = d.dataset_id AND r.factor_id = d.factor_id)
                  THEN 'a scope row' END,
             CASE WHEN EXISTS (SELECT 1 FROM nzi_console.job_emission_sources s
                                WHERE s.organisation_id = d.organisation_id AND s.dataset_id = d.dataset_id AND s.factor_id = d.factor_id)
                  THEN 'an emission source' END,
             CASE WHEN EXISTS (SELECT 1 FROM nzi_console.client_factor_aliases a
                                WHERE a.organisation_id = d.organisation_id AND a.factor_id = d.factor_id)
                  THEN 'a client alias' END)
     WHERE d.organisation_id = org;
    UPDATE migration_0170_divergent SET named_by = NULL WHERE organisation_id = org AND named_by = '';
  END LOOP;
  PERFORM set_config('app.organisation_id', '', true);
END $$;

DO $$
DECLARE unexpected text; unexpected_count bigint; in_use text; in_use_count bigint;
BEGIN
  SELECT string_agg(format('%s/%s %s = %s per %s (base %s = %s per %s)', organisation_id, dataset_id, factor_id,
                           value, unit, base, base_value, base_unit), '; ' ORDER BY organisation_id, dataset_id, factor_id)
    INTO unexpected
    FROM (SELECT * FROM migration_0170_divergent WHERE NOT is_the_freight_defect
           ORDER BY organisation_id, dataset_id, factor_id LIMIT 20) AS listed;
  SELECT count(*) INTO unexpected_count FROM migration_0170_divergent WHERE NOT is_the_freight_defect;
  IF unexpected_count > 0 THEN
    RAISE EXCEPTION '0170: % variant value row(s) differ from their base and are not the characterised freight -d defect, so the guard cannot be added and nothing is corrected. Rule them first. The first of them: %.',
      unexpected_count, unexpected;
  END IF;

  SELECT string_agg(format('%s/%s %s (named by %s)', organisation_id, dataset_id, factor_id, named_by), '; '
                    ORDER BY organisation_id, dataset_id, factor_id)
    INTO in_use
    FROM (SELECT * FROM migration_0170_divergent WHERE named_by IS NOT NULL
           ORDER BY organisation_id, dataset_id, factor_id LIMIT 20) AS listed;
  SELECT count(*) INTO in_use_count FROM migration_0170_divergent WHERE named_by IS NOT NULL;
  IF in_use_count > 0 THEN
    RAISE EXCEPTION '0170: % divergent freight -d row(s) are in use, and correcting a number something is priced on is its own ruling. Nothing is corrected. The first of them: %.',
      in_use_count, in_use;
  END IF;
END $$;

DO $$
DECLARE org text; corrected record; total integer := 0;
BEGIN
  FOR org IN SELECT DISTINCT organisation_id FROM migration_0170_divergent ORDER BY organisation_id LOOP
    PERFORM set_config('app.organisation_id', org, true);
    -- One statement per organisation, so the guard above checks every corrected group as it now stands.
    FOR corrected IN
      UPDATE nzi_console.emission_factors f
         SET kgco2e_per_unit = d.base_value
        FROM migration_0170_divergent d
       WHERE f.organisation_id = org AND d.organisation_id = org
         AND f.dataset_id = d.dataset_id AND f.factor_id = d.factor_id
      RETURNING f.organisation_id, f.dataset_id, f.factor_id, f.activity_unit, d.value AS was, f.kgco2e_per_unit AS now, d.base
    LOOP
      total := total + 1;
      INSERT INTO nzi_console.audit_events
        (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason,
         before_json, after_json)
      VALUES (corrected.organisation_id, gen_random_uuid()::text, 'migration:0170', 'system', 'emission_factor.value.corrected',
        'emission_factor', corrected.dataset_id || '/' || corrected.factor_id, 'migration:0170',
        'A downstream-freight variant carried its per-mile sibling''s value in place of its base''s; set to its base''s, as every variant carries (0110). Ruled 19 Oct 2026 (BUILD-dataset-factor-dedup slice 1).',
        jsonb_build_object('datasetId', corrected.dataset_id, 'factorId', corrected.factor_id, 'activityUnit', corrected.activity_unit,
                           'kgco2ePerUnit', corrected.was),
        jsonb_build_object('datasetId', corrected.dataset_id, 'factorId', corrected.factor_id, 'activityUnit', corrected.activity_unit,
                           'kgco2ePerUnit', corrected.now, 'base', corrected.base));
    END LOOP;
  END LOOP;
  PERFORM set_config('app.organisation_id', '', true);
  RAISE NOTICE '0170 corrected % downstream-freight variant value(s) to their base''s', total;
END $$;

-- The post-condition, re-checked rather than assumed: no variant anywhere differs from its base.
DO $$
DECLARE org text; remaining bigint; total bigint := 0;
BEGIN
  FOR org IN SELECT organisation_id FROM nzi_console.organisations ORDER BY organisation_id LOOP
    PERFORM set_config('app.organisation_id', org, true);
    SELECT count(*) INTO remaining
      FROM nzi_console.emission_factors v
      CROSS JOIN LATERAL nzi_console.factor_id_parts(v.factor_id) p
      JOIN nzi_console.emission_factors b
        ON b.organisation_id = v.organisation_id AND b.dataset_id = v.dataset_id AND b.factor_id = p.base
     WHERE v.organisation_id = org AND p.suffix_code IS NOT NULL
       AND (v.kgco2e_per_unit <> b.kgco2e_per_unit OR v.activity_unit <> b.activity_unit);
    total := total + remaining;
  END LOOP;
  PERFORM set_config('app.organisation_id', '', true);
  IF total > 0 THEN
    RAISE EXCEPTION '0170: % variant(s) still differ from their base after the correction', total;
  END IF;
END $$;

-- ── 4. Applicability, once per factor ─────────────────────────────────────────────────────────────────────────

CREATE TABLE nzi_console.factor_identity_categories (
  organisation_id text NOT NULL,
  factor_id text NOT NULL,
  suffix_code text NOT NULL REFERENCES nzi_console.factor_category_variants (suffix_code),

  -- Retired withholds the category from new use and keeps the record of what the factor was once filed under. There is no
  -- deleted state.
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  retired_at timestamptz,
  retired_by text,
  retired_reason text,
  CONSTRAINT factor_identity_category_retired_shape
    CHECK ((status = 'retired') = (retired_at IS NOT NULL AND retired_by IS NOT NULL AND btrim(coalesce(retired_reason, '')) <> '')),

  source text NOT NULL CHECK (source IN ('migration', 'admin')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,

  PRIMARY KEY (organisation_id, factor_id, suffix_code),
  FOREIGN KEY (organisation_id, factor_id) REFERENCES nzi_console.factor_identities (organisation_id, factor_id)
);
COMMENT ON TABLE nzi_console.factor_identity_categories IS
  'The categories a factor may be filed under: one row per (factor, registered suffix), held once for every year. No value, no dataset, no year — the value stays on the factor''s own row, one per edition. NZI-curated, so it may exceed what the source ships. Applicability belongs to a base factor, never to a variant id.';

CREATE FUNCTION nzi_console.factor_identity_category_is_permanent()
RETURNS trigger
LANGUAGE plpgsql SET search_path = nzi_console, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A factor''s applicability is never deleted: % under % is a record of how it may be filed. Retire it instead.',
      OLD.factor_id, OLD.suffix_code USING ERRCODE = 'raise_exception';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.organisation_id, NEW.factor_id, NEW.suffix_code)
                          IS DISTINCT FROM (OLD.organisation_id, OLD.factor_id, OLD.suffix_code) THEN
    RAISE EXCEPTION 'A factor''s applicability is never re-pointed: % under % stays what it is. Retire it and add the replacement.',
      OLD.factor_id, OLD.suffix_code USING ERRCODE = 'raise_exception';
  END IF;
  IF TG_OP = 'INSERT' AND (SELECT p.suffix_code FROM nzi_console.factor_id_parts(NEW.factor_id) p) IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('Applicability belongs to the base factor: %s is itself a variant of %s.',
                       NEW.factor_id, (SELECT p.base FROM nzi_console.factor_id_parts(NEW.factor_id) p));
  END IF;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION nzi_console.factor_identity_category_is_permanent() IS
  'Refuses to delete or re-point a factor''s applicability, and refuses applicability on a variant id, for every identity — a guard only a grant enforces is one the owner walks past.';
CREATE TRIGGER factor_identity_category_is_permanent
  BEFORE INSERT OR UPDATE OR DELETE ON nzi_console.factor_identity_categories
  FOR EACH ROW EXECUTE FUNCTION nzi_console.factor_identity_category_is_permanent();

ALTER TABLE nzi_console.factor_identity_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.factor_identity_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.factor_identity_categories
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.factor_identity_categories TO nzi_console_app;
REVOKE DELETE ON nzi_console.factor_identity_categories FROM PUBLIC, nzi_console_app;

-- ── 5. The backfill: every materialised variant implies its base's applicability ─────────────────────────────

DO $$
DECLARE org text; added bigint; without_identity bigint;
BEGIN
  FOR org IN SELECT organisation_id FROM nzi_console.organisations ORDER BY organisation_id LOOP
    PERFORM set_config('app.organisation_id', org, true);

    -- A variant whose base was never a factor in this organisation has nothing to be applicable to. None does on the v7
    -- library; said rather than failed on, and named in the deploy log.
    SELECT count(*) INTO without_identity
      FROM (SELECT DISTINCT p.base, p.suffix_code
              FROM nzi_console.emission_factors f CROSS JOIN LATERAL nzi_console.factor_id_parts(f.factor_id) p
             WHERE f.organisation_id = org AND p.suffix_code IS NOT NULL) AS pairs
     WHERE NOT EXISTS (SELECT 1 FROM nzi_console.factor_identities i WHERE i.organisation_id = org AND i.factor_id = pairs.base);

    INSERT INTO nzi_console.factor_identity_categories
      (organisation_id, factor_id, suffix_code, source, created_by, updated_by)
    SELECT DISTINCT org, p.base, p.suffix_code, 'migration', 'migration:0170', 'migration:0170'
      FROM nzi_console.emission_factors f
      CROSS JOIN LATERAL nzi_console.factor_id_parts(f.factor_id) p
     WHERE f.organisation_id = org AND p.suffix_code IS NOT NULL
       AND EXISTS (SELECT 1 FROM nzi_console.factor_identities i WHERE i.organisation_id = org AND i.factor_id = p.base)
    ON CONFLICT (organisation_id, factor_id, suffix_code) DO NOTHING;
    GET DIAGNOSTICS added = ROW_COUNT;

    IF added > 0 OR without_identity > 0 THEN
      RAISE NOTICE '0170 applicability for %: % (factor, category) pair(s) backfilled from materialised variants; % skipped, their base not a factor here',
        org, added, without_identity;
    END IF;
  END LOOP;
  PERFORM set_config('app.organisation_id', '', true);
END $$;
