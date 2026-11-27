-- 0240 V7 client custom factors (cause 7; PLAN-v7-client-custom-factors, D-1/D-2/D-3 approved).
--
-- V7 has two custom-factor families, `custom_factors` and `job_custom_factors` ("Job-Only Factors", `JCF-{job}-{factor}`), each
-- with values per year. The console's client factor holds one value (`kgco2e_per_unit`, its `vintage_year`), and the re-ingest
-- minted one per V7 row. This migration gives a client factor what a V7 factor is:
--
--   1. `legacy_custom_id` — V7's own id (`JCF-669-115`, or a `custom_factors.custom_id`), unique per organisation, client and
--      scope (V7 itself chooses among same-id factors by scope). `source_system` / `legacy_db_id` (0132) stay the import's key.
--   2. `folded_into_client_factor_id` — the loaded factor a re-ingest's one-per-row factor was folded into. A folded factor is
--      archived, never deleted (D-2: one whose row does not reproduce is not folded, and stays live).
--   3. Organisation-level client factors (D-3): V7's global `custom_factors` are offered to every client, so `client_id` may be
--      NULL — such a factor is never pinned to a job. The two boundary triggers accept one on any of the organisation's jobs.
--   4. `client_factor_year_values` — a factor's value per calendar year, per factor version, append-only. The headline value and
--      `vintage_year` stay as they are; the year values are what a month is priced from (`_choose_factor_for_year`: the year's
--      value, else the closest earlier, else the earliest).
--
-- Additive: no existing row changes. Every existing factor has a client, no legacy id and no year values, so it prices exactly
-- as before.

BEGIN;

ALTER TABLE nzi_console.client_factors ADD COLUMN legacy_custom_id text CHECK (legacy_custom_id IS NULL OR btrim(legacy_custom_id) <> '');
ALTER TABLE nzi_console.client_factors ADD COLUMN folded_into_client_factor_id text;
ALTER TABLE nzi_console.client_factors ADD CONSTRAINT client_factor_folded_into_fk
  FOREIGN KEY (organisation_id, folded_into_client_factor_id) REFERENCES nzi_console.client_factors(organisation_id, client_factor_id);
ALTER TABLE nzi_console.client_factors ADD CONSTRAINT client_factor_folded_is_archived
  CHECK (folded_into_client_factor_id IS NULL OR (archived AND folded_into_client_factor_id <> client_factor_id));
ALTER TABLE nzi_console.client_factors ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE nzi_console.client_factors ADD CONSTRAINT client_factor_organisation_level_unpinned CHECK (client_id IS NOT NULL OR job_id IS NULL);
CREATE UNIQUE INDEX client_factors_legacy_custom_id_key
  ON nzi_console.client_factors (organisation_id, coalesce(client_id, ''), legacy_custom_id, scope) WHERE legacy_custom_id IS NOT NULL;
COMMENT ON COLUMN nzi_console.client_factors.legacy_custom_id IS
  'V7''s own id for the factor: JCF-{job}-{factor} for a job-only factor, else custom_factors.custom_id (0240).';
COMMENT ON COLUMN nzi_console.client_factors.folded_into_client_factor_id IS
  'The loaded V7 factor this one-per-row re-ingest factor was folded into; set only when archived (0240).';
COMMENT ON COLUMN nzi_console.client_factors.client_id IS
  'The owning client; NULL for an organisation-level factor (V7''s global custom factors, D-3), offered on every client''s jobs (0240).';

CREATE OR REPLACE FUNCTION nzi_console.enforce_scope_row_client_factor_boundary() RETURNS trigger
LANGUAGE plpgsql SET search_path = nzi_console, pg_temp AS $$
BEGIN
  IF NEW.factor_source = 'client' AND NOT EXISTS (
    SELECT 1 FROM nzi_console.client_factors cf
    JOIN nzi_console.jobs j ON j.organisation_id = cf.organisation_id AND (cf.client_id IS NULL OR j.client_id = cf.client_id)
    WHERE cf.organisation_id=NEW.organisation_id AND cf.client_factor_id=NEW.client_factor_id
      AND j.job_id=NEW.job_id AND (cf.job_id IS NULL OR cf.job_id=NEW.job_id) AND cf.archived=false
  ) THEN RAISE EXCEPTION 'Client factor is outside the scope row job boundary' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION nzi_console.enforce_emission_source_client_factor_boundary() RETURNS trigger
LANGUAGE plpgsql SET search_path = nzi_console, pg_temp AS $$
BEGIN
  IF NEW.factor_source = 'client' AND NOT EXISTS (
    SELECT 1 FROM nzi_console.client_factors cf
    JOIN nzi_console.jobs j ON j.organisation_id = cf.organisation_id AND (cf.client_id IS NULL OR j.client_id = cf.client_id)
    WHERE cf.organisation_id=NEW.organisation_id AND cf.client_factor_id=NEW.client_factor_id
      AND j.job_id=NEW.job_id AND (cf.job_id IS NULL OR cf.job_id=NEW.job_id) AND cf.archived=false
  ) THEN RAISE EXCEPTION 'Client factor is outside the emission source job boundary' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE nzi_console.client_factor_year_values (
  organisation_id text NOT NULL,
  client_factor_id text NOT NULL,
  -- The factor version these values belong to: a re-load that changes them bumps the factor's version and adds a new set.
  version integer NOT NULL CHECK (version > 0),
  year integer NOT NULL CHECK (year BETWEEN 1990 AND 2100),
  kgco2e_per_unit double precision NOT NULL CHECK (kgco2e_per_unit >= 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, client_factor_id, version, year),
  FOREIGN KEY (organisation_id, client_factor_id) REFERENCES nzi_console.client_factors(organisation_id, client_factor_id)
);
COMMENT ON TABLE nzi_console.client_factor_year_values IS
  'A client factor''s value per calendar year, per factor version; append-only. A month is priced at its year''s value, else the closest earlier, else the earliest (0240).';

ALTER TABLE nzi_console.client_factor_year_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_factor_year_values FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_factor_year_values
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
REVOKE ALL ON nzi_console.client_factor_year_values FROM PUBLIC;
GRANT SELECT, INSERT ON nzi_console.client_factor_year_values TO nzi_console_app;
REVOKE UPDATE, DELETE, TRUNCATE ON nzi_console.client_factor_year_values FROM nzi_console_app;

COMMIT;
