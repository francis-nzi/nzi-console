-- 0242 A V7 factor row may back one value row per dataset, not one per organisation (BRIEF-library-cornerstone-activity-spend,
-- DESIGN §3, ruled 27 Nov: L-7 "keep the migration").
--
-- V7 updates a series in place: re-running its Cornerstone importer with the final release rewrites the same `datasets` and
-- `factor_lookup` rows, so every factor keeps its `db_id`. The console loads a new release as a new edition beside the old one
-- (the old one superseded, and still cited by the rows priced on it), so two editions of one Cornerstone dataset carry the
-- same V7 `db_id`. 0126 made `legacy_db_id` unique per organisation, which refuses that.
--
-- The key becomes (organisation, dataset, source system, db_id): the shape `emission_factors_legacy_original_key` already has.
-- Within one dataset a V7 row still backs at most one value row. Nothing else changes, and no row is written.

BEGIN;

DROP INDEX nzi_console.emission_factors_legacy_db_key;
CREATE UNIQUE INDEX emission_factors_legacy_db_key
  ON nzi_console.emission_factors (organisation_id, dataset_id, source_system, legacy_db_id) WHERE source_system IS NOT NULL;

COMMENT ON COLUMN nzi_console.emission_factors.legacy_db_id IS
  'The v7 factor_lookup row this value row was loaded from (db_id). Unique per organisation and dataset: V7 keeps a db_id when it updates a series in place, so each edition the console loads of that series carries it.';

COMMIT;
