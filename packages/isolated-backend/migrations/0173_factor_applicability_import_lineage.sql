-- 0173 A factor's applicability may be written by the reference import, and says which source row it came from
-- (BUILD-dataset-factor-dedup slice 4; ruled 20 Oct 2026: "Migration 0173").
--
-- ## Why
--
-- Slice 4 moves the de-duplication upstream: under REPORT_FACTOR_APPLICABILITY the v7 reference import no longer inserts a
-- `<base><suffix>` value row that carries its base's value, unit and scopes. It records the reuse as the pair it is — (base,
-- suffix) in `factor_identity_categories`, with the variant's curated report label and label (0172) — instead. Two things the
-- table could not say:
--
-- 1. **Who wrote it.** `source` admits 'migration' (0170's backfill) and 'admin' (factor.manage). An import is neither, and
--    writing it as either would mislabel every folded pair.
-- 2. **Which source row it came from.** A factor identity carries `source_system`, `legacy_original_id` and `legacy_db_id`
--    (v7's code verbatim, and its lowest db_id), so an imported identity can be traced back to v7. A folded pair had no row of its
--    own to carry that, so its lineage would be lost — and slice 5 retires the materialised variants on the strength of it.
--
-- ## What this adds
--
-- 1. `source` admits 'import'.
-- 2. `source_system`, `legacy_original_id`, `legacy_db_id` — nullable; set on an imported pair, NULL on every other. A CHECK holds
--    the two together: an imported pair names all three (never blank); a migration or admin pair names none. As on an identity,
--    the code is the variant's verbatim and the db_id the lowest of the rows folded into it. Every folded row, one by one, is in
--    the import's audit event for the pair.
-- 3. **Provenance is permanent.** The 0170 trigger refused re-pointing a pair; it now refuses rewriting where it came from too
--    (`source` and the three lineage columns), for every identity. Status, labels and version stay writable, as before.
--
-- ## What it does not change
--
-- No existing row: all 388 staging pairs are 'migration', with no lineage, which the CHECK admits. No resolved factor, no
-- label, no issued report. The import writes 'import' only on the flag's path (off by default). NZC-120 untouched: no money, no
-- personal data. The runner wraps this.

ALTER TABLE nzi_console.factor_identity_categories
  DROP CONSTRAINT factor_identity_categories_source_check,
  ADD CONSTRAINT factor_identity_category_source CHECK (source IN ('migration', 'admin', 'import')),
  ADD COLUMN source_system text NULL,
  ADD COLUMN legacy_original_id text NULL,
  ADD COLUMN legacy_db_id text NULL,
  ADD CONSTRAINT factor_identity_category_import_lineage CHECK (
    CASE WHEN source = 'import'
         THEN btrim(coalesce(source_system, '')) <> '' AND btrim(coalesce(legacy_original_id, '')) <> ''
              AND btrim(coalesce(legacy_db_id, '')) <> ''
         ELSE source_system IS NULL AND legacy_original_id IS NULL AND legacy_db_id IS NULL END);
COMMENT ON COLUMN nzi_console.factor_identity_categories.source_system IS
  'An imported pair: the system its source row came from (nzi-pro-v7). NULL on a migration or admin pair.';
COMMENT ON COLUMN nzi_console.factor_identity_categories.legacy_original_id IS
  'An imported pair: the source code of the variant folded into it, verbatim (v7 original_id). NULL on a migration or admin pair.';
COMMENT ON COLUMN nzi_console.factor_identity_categories.legacy_db_id IS
  'An imported pair: the lowest source db_id of the variant rows folded into it; every one is in the import''s audit event. NULL on a migration or admin pair.';

CREATE OR REPLACE FUNCTION nzi_console.factor_identity_category_is_permanent()
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
  -- 0173: where a pair came from is a fact about its past, not a setting.
  IF TG_OP = 'UPDATE' AND (NEW.source, NEW.source_system, NEW.legacy_original_id, NEW.legacy_db_id)
                          IS DISTINCT FROM (OLD.source, OLD.source_system, OLD.legacy_original_id, OLD.legacy_db_id) THEN
    RAISE EXCEPTION 'A factor''s applicability keeps where it came from: % under % was written by % and stays so.',
      OLD.factor_id, OLD.suffix_code, OLD.source USING ERRCODE = 'raise_exception';
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
  'Refuses to delete or re-point a factor''s applicability, to rewrite where it came from (0173), and refuses applicability on a variant id, for every identity — a guard only a grant enforces is one the owner walks past.';
