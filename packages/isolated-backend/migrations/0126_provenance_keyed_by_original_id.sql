-- 0126 v7 provenance: each factor points back at its factor_lookup row, each identity is one code within one source
-- family, and the variant registry matches v7's suffixes (REFERENCE_DATA_DESIGN §3–4).
--
-- ## Why
--
-- 0125 took `legacy_factor_id` (v7's `definitions.factor_id`) as the identity key, unique within a dataset. It is not:
-- factor 9759 alone is five flight classes in one dataset. The import's source of record is now v7's `factor_lookup`
-- (its category is the operationally correct, suffix-aware one; the definitions' is stale on suffixed rows), so the
-- durable back-reference is the lookup row's `db_id`, and the identity is the source code, `original_id`, within its
-- source family. The factor id is minted as `<family>-<normalised original_id>`: ICE uses bare integers ("1"–"8"), IEA
-- uses country names, so the same code in two families is two different factors. 0125 is merged and frozen, so the roles
-- are corrected here.
--
-- ## What changes
--
-- 1. **Back-references.** `legacy_factor_id` goes from both tables. `emission_factors.legacy_db_id` is the
--    `factor_lookup` row a value row came from — unique per organisation, so a re-run lands on the same rows.
--    `factor_identities.legacy_db_id` is the lowest `db_id` carrying the code: a stable pointer back into the source.
--    `legacy_original_id` stays on both; it is stored exactly as v7 has it, which is what makes the normalised id
--    reversible.
-- 2. **One code per family, one family per identity.** An identity records its source family, and uniqueness is
--    (organisation, source system, family, original_id) — ICE's "1" and another family's "1" are separate identities.
--    A factor whose dataset belongs to another family than its identity is refused, wherever it is written from.
-- 3. **The variant registry matches v7.** Five of v7's ten suffixes were registered (`-b -c -d -p -u`, 0110); the other
--    five are added: `-vcd`, `-vcp`, `-vh`, `-vvd` — company-vehicle sub-types, Scope 1 — and `-bcp`, business travel by
--    petrol car (3.6). Variants span scopes. `-w` (waste, 0110) is not a v7 suffix; it is retired by the audited
--    `factor.variant.retire` command, not here.
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

-- ── 1. Back-references ────────────────────────────────────────────────────────────────────────────────────────

DROP INDEX nzi_console.emission_factors_legacy_key;
DROP INDEX nzi_console.factor_identities_legacy_key;

ALTER TABLE nzi_console.emission_factors DROP CONSTRAINT emission_factor_provenance_shape;
ALTER TABLE nzi_console.emission_factors
  DROP COLUMN legacy_factor_id,
  ADD COLUMN legacy_db_id text,
  ADD CONSTRAINT emission_factor_provenance_shape
    CHECK (source_system IS NULL OR (legacy_original_id IS NOT NULL AND legacy_db_id IS NOT NULL));
CREATE UNIQUE INDEX emission_factors_legacy_original_key
  ON nzi_console.emission_factors (organisation_id, dataset_id, source_system, legacy_original_id) WHERE source_system IS NOT NULL;
CREATE UNIQUE INDEX emission_factors_legacy_db_key
  ON nzi_console.emission_factors (organisation_id, source_system, legacy_db_id) WHERE source_system IS NOT NULL;

ALTER TABLE nzi_console.factor_identities DROP CONSTRAINT factor_identity_provenance_shape;
ALTER TABLE nzi_console.factor_identities
  DROP COLUMN legacy_factor_id,
  ADD COLUMN legacy_db_id text,
  ADD COLUMN legacy_original_id text,
  ADD COLUMN source_family text,
  ADD CONSTRAINT factor_identity_provenance_shape
    CHECK (source_system IS NULL OR (legacy_original_id IS NOT NULL AND source_family IS NOT NULL));
CREATE UNIQUE INDEX factor_identities_legacy_original_key
  ON nzi_console.factor_identities (organisation_id, source_system, source_family, legacy_original_id) WHERE source_system IS NOT NULL;

COMMENT ON COLUMN nzi_console.emission_factors.legacy_original_id IS
  'The source code for this factor exactly as v7 stores it (factor_lookup.original_id). The factor_id is minted from it, normalised and prefixed with the source family; this column is what makes that reversible.';
COMMENT ON COLUMN nzi_console.emission_factors.legacy_db_id IS
  'The v7 factor_lookup row this value row was loaded from (db_id). Unique per organisation.';
COMMENT ON COLUMN nzi_console.factor_identities.legacy_original_id IS
  'The source code this identity stands for, exactly as v7 stores it. One identity per code per source family, curated once for every year and country that uses it.';
COMMENT ON COLUMN nzi_console.factor_identities.legacy_db_id IS
  'The lowest v7 factor_lookup db_id carrying this code: a stable pointer back into the source for the identity.';
COMMENT ON COLUMN nzi_console.factor_identities.source_family IS
  'The source family the code belongs to. A factor from a dataset of another family is refused: one family per identity.';

-- ── 2. One family per identity — enforced where every writer passes ──────────────────────────────────────────

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
    (organisation_id, factor_id, label, source_label, source_system, legacy_db_id, legacy_original_id, source_family, created_by)
  VALUES (NEW.organisation_id, NEW.factor_id, NEW.label, NEW.label, NEW.source_system, NEW.legacy_db_id,
          NEW.legacy_original_id, CASE WHEN NEW.source_system IS NULL THEN NULL ELSE dataset_family END, 'factor-insert')
  ON CONFLICT (organisation_id, factor_id) DO NOTHING;

  IF NEW.source_system IS NOT NULL THEN
    SELECT source_family, source_system INTO identity_family, identity_system
      FROM nzi_console.factor_identities
     WHERE (organisation_id, factor_id) = (NEW.organisation_id, NEW.factor_id);
    IF identity_system IS NOT NULL AND identity_family IS DISTINCT FROM dataset_family THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = format('%s belongs to source family %s and cannot also come from %s (dataset %s): one family per identity',
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
