-- 0125 A factor's curated identity lives once, and every year's value row points at it (REFERENCE_DATA_DESIGN §2–4, §6).
--
-- ## Why
--
-- `emission_factors` is one row per (dataset, factor_id): value and label together, per year. NZI curates a factor's
-- identity — its label, its report wording, its business category, its hierarchy — and refines it over months. With
-- the label copied into every year's row, curating 2024 and then adding 2025 loses the edit. v7 normalised for exactly
-- this reason. The console keeps the flat value table (the resolver needs nothing else) and gains the curated half.
--
-- ## What this adds
--
-- 1. `factor_identities`, keyed by (organisation_id, factor_id): the curated fields, once, for every year.
-- 2. A foreign key from every value row to its identity — one identity per factor by construction. Existing factors
--    are backfilled from their own labels, and a trigger gives any factor inserted without an identity one made from
--    its label, so a loader that writes curated identities first keeps them and every other writer keeps working.
-- 3. `emission_factors_display`, a security_invoker view (row-level security applies to the caller): the value row
--    with the curated label, report label, levels and category. The read paths that show a label use it; the
--    resolver does not — it resolves by factor_id and dataset and reads only unit and scopes.
-- 4. Provenance on `emission_factors` and `emission_factor_datasets` for the v7 import, with the checks and the
--    one-to-one key that make it re-runnable.
-- 5. `client_factor_aliases` re-keyed from (client, dataset_id, factor_id) to (client, factor_id). What a client calls
--    a factor belongs to the factor, not to a year's dataset: keyed by dataset, an alias written against 2024 did not
--    apply to a 2025 row. Existing aliases are folded; if one client's active names for one factor disagree, this
--    refuses and says which, rather than choosing.
--
-- ## What it does not change
--
-- No value, unit or scope moves. No resolved factor changes. Labels shown stay what they were until somebody curates:
-- the backfilled identity is the factor's own label.

BEGIN;

DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION '0125 needs PostgreSQL 15 or later: the display view is security_invoker so row-level security applies to the reader';
  END IF;
END $$;

-- ── 1. The identity ───────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE nzi_console.factor_identities (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  factor_id text NOT NULL CHECK (btrim(factor_id) <> ''),
  label text NOT NULL CHECK (btrim(label) <> ''),
  report_label text CHECK (report_label IS NULL OR btrim(report_label) <> ''),
  business_category text CHECK (business_category IS NULL OR btrim(business_category) <> ''),
  levels text[] NOT NULL DEFAULT '{}',
  source_label text NOT NULL,
  source_system text,
  legacy_factor_id text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  curated_by text,
  curated_at timestamptz,
  PRIMARY KEY (organisation_id, factor_id),
  CONSTRAINT factor_identity_curation_shape CHECK ((curated_by IS NULL) = (curated_at IS NULL)),
  CONSTRAINT factor_identity_provenance_shape CHECK (source_system IS NULL OR legacy_factor_id IS NOT NULL)
);
COMMENT ON TABLE nzi_console.factor_identities IS
  'A factor''s curated identity — label, report wording, business category, hierarchy — held once and applying to every year''s value row for that factor_id. Value, unit and scopes stay on emission_factors, per edition.';
COMMENT ON COLUMN nzi_console.factor_identities.source_label IS
  'What the source called the factor when it was first loaded. Kept so a later import can be diffed against it; never shown in place of the curated label.';
CREATE UNIQUE INDEX factor_identities_legacy_key
  ON nzi_console.factor_identities (organisation_id, source_system, legacy_factor_id) WHERE source_system IS NOT NULL;

ALTER TABLE nzi_console.factor_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.factor_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.factor_identities
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.factor_identities TO nzi_console_app;
REVOKE DELETE ON nzi_console.factor_identities FROM PUBLIC, nzi_console_app;

-- ── 2. Provenance ─────────────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE nzi_console.emission_factors
  ADD COLUMN source_system text,
  ADD COLUMN legacy_factor_id text,
  ADD COLUMN legacy_original_id text,
  ADD COLUMN source_levels text[],
  ADD COLUMN source_category text,
  ADD COLUMN ghg_unit text,
  ADD CONSTRAINT emission_factor_provenance_shape
    CHECK (source_system IS NULL OR (legacy_factor_id IS NOT NULL AND legacy_original_id IS NOT NULL));
COMMENT ON COLUMN nzi_console.emission_factors.legacy_factor_id IS
  'The source''s cross-year identity for this factor (v7 definitions.factor_id). Stable across editions; the factor_id is minted from it.';
COMMENT ON COLUMN nzi_console.emission_factors.legacy_original_id IS
  'The source''s per-edition identifier (v7 original_id). Varies across editions; provenance only.';
CREATE UNIQUE INDEX emission_factors_legacy_key
  ON nzi_console.emission_factors (organisation_id, dataset_id, source_system, legacy_factor_id) WHERE source_system IS NOT NULL;

ALTER TABLE nzi_console.emission_factor_datasets
  ADD COLUMN source_system text,
  ADD COLUMN source_family text,
  ADD COLUMN legacy_dataset_id text,
  ADD COLUMN content_sha256 text CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT emission_factor_dataset_provenance_shape
    CHECK (source_system IS NULL OR (source_family IS NOT NULL AND legacy_dataset_id IS NOT NULL AND content_sha256 IS NOT NULL));
COMMENT ON COLUMN nzi_console.emission_factor_datasets.content_sha256 IS
  'A hash of the dataset''s rows in canonical order. A load with the same hash is a no-op; a different hash for an existing dataset is refused — a changed edition is a new dataset.';

-- ── 3. Backfill, tenant by tenant (forced row-level security applies to the migration's own writes) ─────────────

DO $$
DECLARE org text;
BEGIN
  FOR org IN SELECT organisation_id FROM nzi_console.organisations ORDER BY organisation_id LOOP
    PERFORM set_config('app.organisation_id', org, true);
    -- One identity per factor_id, labelled as the factor's most recent edition labels it.
    INSERT INTO nzi_console.factor_identities (organisation_id, factor_id, label, source_label, created_by)
    SELECT DISTINCT ON (f.factor_id) f.organisation_id, f.factor_id, f.label, f.label, 'migration:0125'
      FROM nzi_console.emission_factors f
      JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id, d.dataset_id) = (f.organisation_id, f.dataset_id)
     WHERE f.organisation_id = org
     ORDER BY f.factor_id, d.valid_to DESC, d.dataset_id DESC
    ON CONFLICT (organisation_id, factor_id) DO NOTHING;
  END LOOP;
END $$;

-- ── 4. One identity per factor, by construction ───────────────────────────────────────────────────────────────

CREATE FUNCTION nzi_console.ensure_factor_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  -- A curated identity already in place is never touched: a loader writes identities first, and a later edition of
  -- the same factor keeps whatever NZI has curated.
  INSERT INTO nzi_console.factor_identities (organisation_id, factor_id, label, source_label, source_system, legacy_factor_id, created_by)
  VALUES (NEW.organisation_id, NEW.factor_id, NEW.label, NEW.label, NEW.source_system, NEW.legacy_factor_id, 'factor-insert')
  ON CONFLICT (organisation_id, factor_id) DO NOTHING;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION nzi_console.ensure_factor_identity() IS
  'Gives a factor inserted without an identity one made from its own label, so the foreign key holds for every writer. Never overwrites an existing identity.';
CREATE TRIGGER ensure_factor_identity
  BEFORE INSERT OR UPDATE OF factor_id ON nzi_console.emission_factors
  FOR EACH ROW EXECUTE FUNCTION nzi_console.ensure_factor_identity();

ALTER TABLE nzi_console.emission_factors
  ADD CONSTRAINT emission_factors_identity_fk
  FOREIGN KEY (organisation_id, factor_id) REFERENCES nzi_console.factor_identities (organisation_id, factor_id);

-- ── 5. The read path ──────────────────────────────────────────────────────────────────────────────────────────

CREATE VIEW nzi_console.emission_factors_display WITH (security_invoker = true) AS
SELECT f.organisation_id, f.dataset_id, f.factor_id,
       i.label,                      -- the curated label: what every screen shows
       i.report_label,
       i.business_category,
       i.levels,
       f.label AS edition_label,     -- what this edition of the source called it
       f.activity_unit, f.kgco2e_per_unit, f.scopes, f.active
  FROM nzi_console.emission_factors f
  JOIN nzi_console.factor_identities i ON (i.organisation_id, i.factor_id) = (f.organisation_id, f.factor_id);
COMMENT ON VIEW nzi_console.emission_factors_display IS
  'Each factor value row with its curated identity. security_invoker, so the reader''s row-level security applies to both tables.';
GRANT SELECT ON nzi_console.emission_factors_display TO nzi_console_app;

-- ── 6. Client aliases name the factor, not a year's dataset ────────────────────────────────────────────────────

DO $$
DECLARE org text; conflicts text;
BEGIN
  FOR org IN SELECT organisation_id FROM nzi_console.organisations ORDER BY organisation_id LOOP
    PERFORM set_config('app.organisation_id', org, true);
    SELECT string_agg(format('%s / %s: %s', client_id, factor_id, labels), '; ')
      INTO conflicts
      FROM (SELECT client_id, factor_id, string_agg(DISTINCT label, ' | ') AS labels
              FROM nzi_console.client_factor_aliases
             WHERE organisation_id = org AND active
             GROUP BY client_id, factor_id
            HAVING count(DISTINCT label) > 1) disagreeing;
    IF conflicts IS NOT NULL THEN
      RAISE EXCEPTION '0125 cannot fold client aliases in %: one client names one factor differently in different datasets — %. Settle each, then re-run.', org, conflicts;
    END IF;
    -- Keep one row per (client, factor): the active one where there is one, else the most recently changed.
    DELETE FROM nzi_console.client_factor_aliases a
     USING (SELECT organisation_id, client_id, factor_id, dataset_id,
                   row_number() OVER (PARTITION BY organisation_id, client_id, factor_id
                                      ORDER BY active DESC, coalesce(updated_at, created_at) DESC, dataset_id) AS keep_rank
              FROM nzi_console.client_factor_aliases WHERE organisation_id = org) ranked
     WHERE (a.organisation_id, a.client_id, a.factor_id, a.dataset_id) = (ranked.organisation_id, ranked.client_id, ranked.factor_id, ranked.dataset_id)
       AND ranked.keep_rank > 1;
  END LOOP;
END $$;

-- Dropping the column drops the dataset-keyed primary key and foreign key with it.
ALTER TABLE nzi_console.client_factor_aliases DROP COLUMN dataset_id;
ALTER TABLE nzi_console.client_factor_aliases
  ADD PRIMARY KEY (organisation_id, client_id, factor_id),
  ADD CONSTRAINT client_factor_aliases_identity_fk
    FOREIGN KEY (organisation_id, factor_id) REFERENCES nzi_console.factor_identities (organisation_id, factor_id);
COMMENT ON TABLE nzi_console.client_factor_aliases IS
  'What one client calls one shared factor, across every edition of it. A label and nothing else — it cannot carry a value, which is what makes it display rather than measurement.';

COMMIT;
