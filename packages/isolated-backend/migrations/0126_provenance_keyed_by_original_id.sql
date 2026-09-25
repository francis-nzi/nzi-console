-- 0126 v7 provenance is keyed by original_id, not definitions.factor_id (REFERENCE_DATA_DESIGN §3–4).
--
-- ## Why
--
-- 0125 made `legacy_factor_id` (v7's `definitions.factor_id`) the identity key, unique within a dataset. Diagnostics on
-- live then showed it is not: definition 9759 is five distinct flight-class factors in one dataset, five values, the
-- same path and unit. `(dataset_id, original_id)` is the pair that is unique — zero duplicates — and `original_id`
-- recurs across years and countries, so it is the identity. The factor id is minted as `v7-<original_id>`.
--
-- 0125's key on `legacy_factor_id` would refuse the import outright. 0125 is merged and frozen, so the roles are
-- corrected here.
--
-- ## What changes
--
-- - The unique keys on `legacy_factor_id` go; uniqueness moves to `legacy_original_id`: per dataset for factors, per
--   organisation for identities (one identity per source code, across every year and country).
-- - `factor_identities` gains `legacy_original_id`, required wherever `source_system` is set.
-- - The identity trigger carries `legacy_original_id` across.
-- - `legacy_factor_id` stays on both tables as secondary provenance.
--
-- No row carries `source_system` yet — the import has not run — so nothing is re-keyed; this refuses if that is
-- no longer true.

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

DROP INDEX nzi_console.emission_factors_legacy_key;
DROP INDEX nzi_console.factor_identities_legacy_key;

CREATE UNIQUE INDEX emission_factors_legacy_original_key
  ON nzi_console.emission_factors (organisation_id, dataset_id, source_system, legacy_original_id) WHERE source_system IS NOT NULL;

ALTER TABLE nzi_console.factor_identities ADD COLUMN legacy_original_id text;
ALTER TABLE nzi_console.factor_identities DROP CONSTRAINT factor_identity_provenance_shape;
ALTER TABLE nzi_console.factor_identities ADD CONSTRAINT factor_identity_provenance_shape
  CHECK (source_system IS NULL OR legacy_original_id IS NOT NULL);
CREATE UNIQUE INDEX factor_identities_legacy_original_key
  ON nzi_console.factor_identities (organisation_id, source_system, legacy_original_id) WHERE source_system IS NOT NULL;

COMMENT ON COLUMN nzi_console.emission_factors.legacy_original_id IS
  'The source''s identity for this factor (v7 original_id): unique within a dataset, and the same across the years and countries that use it. The factor_id is minted from it: v7-<original_id>.';
COMMENT ON COLUMN nzi_console.emission_factors.legacy_factor_id IS
  'v7 definitions.factor_id — secondary provenance. Not unique within a dataset: one definition can hold several factors.';
COMMENT ON COLUMN nzi_console.factor_identities.legacy_original_id IS
  'The source code this identity stands for (v7 original_id). One identity per code, curated once for every year and country that uses it.';

CREATE OR REPLACE FUNCTION nzi_console.ensure_factor_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  -- A curated identity already in place is never touched: a loader writes identities first, and a later edition of
  -- the same factor keeps whatever NZI has curated.
  INSERT INTO nzi_console.factor_identities
    (organisation_id, factor_id, label, source_label, source_system, legacy_factor_id, legacy_original_id, created_by)
  VALUES (NEW.organisation_id, NEW.factor_id, NEW.label, NEW.label, NEW.source_system, NEW.legacy_factor_id,
          NEW.legacy_original_id, 'factor-insert')
  ON CONFLICT (organisation_id, factor_id) DO NOTHING;
  RETURN NEW;
END $$;

COMMIT;
