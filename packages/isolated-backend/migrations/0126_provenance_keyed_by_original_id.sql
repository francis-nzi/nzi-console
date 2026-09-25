-- 0126 v7 provenance is keyed by original_id, one identity per code within one source family, and the variant
-- registry matches v7's suffixes (REFERENCE_DATA_DESIGN §3–4).
--
-- ## Why
--
-- 0125 made `legacy_factor_id` (v7's `definitions.factor_id`) the identity key, unique within a dataset. Diagnostics on
-- live then showed it is not: definition 9759 is five distinct flight-class factors in one dataset, five values, the
-- same path and unit. `(dataset_id, original_id)` is the pair that is unique — zero duplicates — and `original_id`
-- recurs across years and countries, so it is the identity. The factor id is minted as `v7-<original_id>`. 0125 is
-- merged and frozen, so the roles are corrected here.
--
-- ## What changes
--
-- 1. **Keys.** The unique keys on `legacy_factor_id` go; uniqueness moves to `legacy_original_id`: per dataset for
--    factors, per organisation for identities. `legacy_factor_id` stays as secondary provenance.
-- 2. **One code, one family (ruled 25 Sep 2026).** An identity records the source family it belongs to, and a factor
--    whose dataset is of another family is refused. `v7-<original_id>` is one identity across every year and country
--    of its family; a code that turns up in two families would merge two different factors into one, so it is refused
--    rather than reported.
-- 3. **The variant registry matches v7.** v7 allocates one physical factor to several categories by suffixing its
--    `original_id`. Five of its ten suffixes were already registered (`-b -c -d -p -u`, 0110); the other five are
--    added: `-vcd`, `-vcp`, `-vh`, `-vvd` — company-vehicle sub-types, Scope 1 — and `-bcp`, business travel by petrol
--    car (3.6). Variants therefore span scopes. `-w` (waste, 0110) is not a v7 suffix and is left for a ruling:
--    retiring it is the audited `factor.variant.retire` command, not a migration.
--
-- No row carries `source_system` yet — the import has not run — so nothing is re-keyed; this refuses if that is no
-- longer true.

BEGIN;

DO $$
DECLARE org text; loaded bigint := 0; n bigint;
BEGIN
  -- Row-level security is forced on both tables; an unset tenant would read nothing and prove nothing, so count as
  -- each organisation in turn.
  FOR org IN SELECT organisation_id FROM nzi_console.organisations LOOP
    PERFORM set_config('app.organisation_id', org, true);
    SELECT count(*) INTO n FROM nzi_console.emission_factors WHERE source_system IS NOT NULL;
    loaded := loaded + n;
    SELECT count(*) INTO n FROM nzi_console.factor_identities WHERE source_system IS NOT NULL;
    loaded := loaded + n;
  END LOOP;
  IF loaded > 0 THEN
    RAISE EXCEPTION '0126 expected no imported rows yet, found %: re-keying loaded provenance is its own migration', loaded;
  END IF;
END $$;

-- ── 1. Keys ───────────────────────────────────────────────────────────────────────────────────────────────────

DROP INDEX nzi_console.emission_factors_legacy_key;
DROP INDEX nzi_console.factor_identities_legacy_key;

CREATE UNIQUE INDEX emission_factors_legacy_original_key
  ON nzi_console.emission_factors (organisation_id, dataset_id, source_system, legacy_original_id) WHERE source_system IS NOT NULL;

ALTER TABLE nzi_console.factor_identities
  ADD COLUMN legacy_original_id text,
  ADD COLUMN source_family text;
ALTER TABLE nzi_console.factor_identities DROP CONSTRAINT factor_identity_provenance_shape;
ALTER TABLE nzi_console.factor_identities ADD CONSTRAINT factor_identity_provenance_shape
  CHECK (source_system IS NULL OR (legacy_original_id IS NOT NULL AND source_family IS NOT NULL));
CREATE UNIQUE INDEX factor_identities_legacy_original_key
  ON nzi_console.factor_identities (organisation_id, source_system, legacy_original_id) WHERE source_system IS NOT NULL;

COMMENT ON COLUMN nzi_console.emission_factors.legacy_original_id IS
  'The source''s identity for this factor (v7 original_id): unique within a dataset, and the same across the years and countries of its family that use it. The factor_id is minted from it: v7-<original_id>.';
COMMENT ON COLUMN nzi_console.emission_factors.legacy_factor_id IS
  'v7 definitions.factor_id — secondary provenance. Not unique within a dataset: one definition can hold several factors.';
COMMENT ON COLUMN nzi_console.factor_identities.legacy_original_id IS
  'The source code this identity stands for (v7 original_id). One identity per code, curated once for every year and country that uses it.';
COMMENT ON COLUMN nzi_console.factor_identities.source_family IS
  'The source family the code belongs to. A factor from a dataset of another family is refused: one code, one family.';

-- ── 2. One code, one family — enforced where every writer passes ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION nzi_console.ensure_factor_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE dataset_family text; identity_family text; identity_system text;
BEGIN
  SELECT source_family INTO dataset_family
    FROM nzi_console.emission_factor_datasets
   WHERE (organisation_id, dataset_id) = (NEW.organisation_id, NEW.dataset_id);

  -- A curated identity already in place is never touched: a loader writes identities first, and a later edition of
  -- the same factor keeps whatever NZI has curated.
  INSERT INTO nzi_console.factor_identities
    (organisation_id, factor_id, label, source_label, source_system, legacy_factor_id, legacy_original_id, source_family, created_by)
  VALUES (NEW.organisation_id, NEW.factor_id, NEW.label, NEW.label, NEW.source_system, NEW.legacy_factor_id,
          NEW.legacy_original_id, CASE WHEN NEW.source_system IS NULL THEN NULL ELSE dataset_family END, 'factor-insert')
  ON CONFLICT (organisation_id, factor_id) DO NOTHING;

  IF NEW.source_system IS NOT NULL THEN
    SELECT source_family, source_system INTO identity_family, identity_system
      FROM nzi_console.factor_identities
     WHERE (organisation_id, factor_id) = (NEW.organisation_id, NEW.factor_id);
    IF identity_system IS NOT NULL AND identity_family IS DISTINCT FROM dataset_family THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = format('%s belongs to source family %s and cannot also come from %s (dataset %s): one code, one family',
                         NEW.factor_id, identity_family, coalesce(dataset_family, 'no family'), NEW.dataset_id);
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ── 3. The variant registry matches v7's suffixes ─────────────────────────────────────────────────────────────

INSERT INTO nzi_console.factor_category_variants
  (suffix_code, label, ghg_category, description, sort_order, created_by, updated_by)
VALUES
  ('-vcd', 'Company vehicles — cars, diesel', '1',
   'The same factor used for a diesel car the organisation owns or controls.', 70, 'migration:0126', 'migration:0126'),
  ('-vcp', 'Company vehicles — cars, petrol', '1',
   'The same factor used for a petrol car the organisation owns or controls.', 80, 'migration:0126', 'migration:0126'),
  ('-vh', 'Company vehicles — HGVs', '1',
   'The same factor used for a heavy goods vehicle the organisation owns or controls.', 90, 'migration:0126', 'migration:0126'),
  ('-vvd', 'Company vehicles — vans, diesel', '1',
   'The same factor used for a diesel van the organisation owns or controls.', 100, 'migration:0126', 'migration:0126'),
  ('-bcp', 'Business travel — car, petrol', '3.6',
   'The same factor used for a work journey by petrol car that is not a commute.', 110, 'migration:0126', 'migration:0126');

COMMIT;
