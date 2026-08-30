BEGIN;

-- Per-entity register (individual assets, vehicles, employees) that rolls up
-- into canonical scope rows, with a kind-specific detail store.
CREATE TABLE nzi_console.job_emission_groups (
  organisation_id text NOT NULL,
  group_id text NOT NULL,
  job_id text NOT NULL,
  name text NOT NULL CHECK (nullif(trim(name), '') IS NOT NULL),
  dataset_id text,
  factor_id text,
  factor_label text,
  unit text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, group_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id) ON DELETE CASCADE
);

CREATE TABLE nzi_console.job_emission_sources (
  organisation_id text NOT NULL,
  source_id text NOT NULL,
  job_id text NOT NULL,
  group_id text,
  scope text NOT NULL,
  source_type text NOT NULL DEFAULT 'asset' CHECK (source_type IN ('asset', 'vehicle', 'commuting', 'spend')),
  source_subtype text,
  site_id text,
  source_name text NOT NULL,
  asset_identifier text CHECK (asset_identifier IS NULL OR char_length(asset_identifier) <= 240),
  dataset_id text,
  factor_id text,
  factor_source text NOT NULL DEFAULT 'dataset' CHECK (factor_source IN ('dataset', 'client')),
  client_factor_id text,
  quantity numeric,
  unit text,
  apply_pct numeric NOT NULL DEFAULT 100 CHECK (apply_pct >= 0 AND apply_pct <= 100),
  data_source text NOT NULL DEFAULT 'Source Register',
  data_confidence text CHECK (data_confidence IN ('H', 'M', 'L')),
  monthly_activity_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(monthly_activity_json) = 'array'),
  detail_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  calculated_tco2e numeric,
  enabled boolean NOT NULL DEFAULT true,
  submitted_by_portal boolean NOT NULL DEFAULT false,
  review_status text CHECK (review_status IN ('pending', 'approved', 'rejected')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, source_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, group_id) REFERENCES nzi_console.job_emission_groups(organisation_id, group_id) ON DELETE SET NULL,
  FOREIGN KEY (organisation_id, site_id) REFERENCES nzi_console.client_sites(organisation_id, site_id),
  FOREIGN KEY (organisation_id, client_factor_id) REFERENCES nzi_console.client_factors(organisation_id, client_factor_id)
);
ALTER TABLE nzi_console.job_emission_sources ADD CONSTRAINT emission_source_client_factor_presence CHECK ((factor_source = 'client') = (client_factor_id IS NOT NULL));

CREATE FUNCTION nzi_console.enforce_emission_source_client_factor_boundary() RETURNS trigger
LANGUAGE plpgsql SET search_path = nzi_console, pg_temp AS $$
BEGIN
  IF NEW.factor_source = 'client' AND NOT EXISTS (
    SELECT 1 FROM nzi_console.client_factors cf
    JOIN nzi_console.jobs j ON (j.organisation_id,j.client_id)=(cf.organisation_id,cf.client_id)
    WHERE cf.organisation_id=NEW.organisation_id AND cf.client_factor_id=NEW.client_factor_id
      AND j.job_id=NEW.job_id AND (cf.job_id IS NULL OR cf.job_id=NEW.job_id) AND cf.archived=false
  ) THEN RAISE EXCEPTION 'Client factor is outside the emission source job boundary' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER emission_source_client_factor_boundary
BEFORE INSERT OR UPDATE OF job_id,factor_source,client_factor_id ON nzi_console.job_emission_sources
FOR EACH ROW EXECUTE FUNCTION nzi_console.enforce_emission_source_client_factor_boundary();
CREATE INDEX job_emission_sources_job_type_enabled_idx ON nzi_console.job_emission_sources(organisation_id, job_id, source_type, enabled);
CREATE INDEX job_emission_sources_group_idx ON nzi_console.job_emission_sources(organisation_id, group_id);

-- Canonical row: roll-up linkage to the register entry it derives from.
ALTER TABLE nzi_console.job_scope_rows ADD COLUMN source_id text;
ALTER TABLE nzi_console.job_scope_rows ADD COLUMN linked_row_id text;
ALTER TABLE nzi_console.job_scope_rows ADD COLUMN is_auto_generated boolean NOT NULL DEFAULT false;
ALTER TABLE nzi_console.job_scope_rows ADD COLUMN auto_pair_kind text;
ALTER TABLE nzi_console.job_scope_rows ADD CONSTRAINT scope_row_source_fk FOREIGN KEY (organisation_id, source_id) REFERENCES nzi_console.job_emission_sources(organisation_id, source_id) ON DELETE SET NULL;

ALTER TABLE nzi_console.job_emission_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.job_emission_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.job_emission_groups USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
ALTER TABLE nzi_console.job_emission_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.job_emission_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.job_emission_sources USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.job_emission_groups TO nzi_console_app;
GRANT SELECT, INSERT, UPDATE ON nzi_console.job_emission_sources TO nzi_console_app;
GRANT EXECUTE ON FUNCTION nzi_console.enforce_emission_source_client_factor_boundary() TO nzi_console_app;

COMMIT;
