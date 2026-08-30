BEGIN;

-- Client-specific ("custom") emission factors, reusable across a client's jobs
-- or pinned to one job, with an optional supporting evidence file (e.g. an EPD).
CREATE TABLE nzi_console.client_factors (
  organisation_id text NOT NULL,
  client_factor_id text NOT NULL,
  client_id text NOT NULL,
  job_id text,
  scope text NOT NULL,
  category_path_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(category_path_json) = 'array'),
  report_label text NOT NULL CHECK (nullif(trim(report_label), '') IS NOT NULL),
  description text NOT NULL DEFAULT '',
  unit text NOT NULL,
  ghg_unit text NOT NULL DEFAULT 'kgCO2e',
  kgco2e_per_unit double precision NOT NULL CHECK (kgco2e_per_unit >= 0),
  geography text NOT NULL DEFAULT 'GB',
  vintage_year integer NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source text NOT NULL DEFAULT '',
  evidence_file_name text,
  evidence_storage_provider text CHECK (evidence_storage_provider IN ('local', 'sharepoint')),
  evidence_url text,
  evidence_external_item_id text,
  evidence_hash text,
  archived boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz,
  PRIMARY KEY (organisation_id, client_factor_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id),
  CONSTRAINT client_factor_evidence_hashed CHECK (evidence_file_name IS NULL OR evidence_hash IS NOT NULL)
);
CREATE INDEX client_factors_client_idx ON nzi_console.client_factors(organisation_id, client_id, archived);

CREATE FUNCTION nzi_console.enforce_client_factor_job_boundary() RETURNS trigger
LANGUAGE plpgsql SET search_path = nzi_console, pg_temp AS $$
BEGIN
  IF NEW.job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM nzi_console.jobs j WHERE j.organisation_id=NEW.organisation_id
      AND j.job_id=NEW.job_id AND j.client_id=NEW.client_id
  ) THEN RAISE EXCEPTION 'Client factor job does not belong to its client' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER client_factor_job_boundary
BEFORE INSERT OR UPDATE OF client_id,job_id ON nzi_console.client_factors
FOR EACH ROW EXECUTE FUNCTION nzi_console.enforce_client_factor_job_boundary();

-- Canonical row: which factor source, and (when client) which client factor.
ALTER TABLE nzi_console.job_scope_rows ADD COLUMN factor_source text NOT NULL DEFAULT 'dataset' CHECK (factor_source IN ('dataset', 'client'));
ALTER TABLE nzi_console.job_scope_rows ADD COLUMN client_factor_id text;
ALTER TABLE nzi_console.job_scope_rows ADD COLUMN is_custom_entry boolean NOT NULL DEFAULT false;
ALTER TABLE nzi_console.job_scope_rows ADD CONSTRAINT scope_row_client_factor_fk FOREIGN KEY (organisation_id, client_factor_id) REFERENCES nzi_console.client_factors(organisation_id, client_factor_id);
ALTER TABLE nzi_console.job_scope_rows ADD CONSTRAINT scope_row_client_factor_presence CHECK ((factor_source = 'client') = (client_factor_id IS NOT NULL));
ALTER TABLE nzi_console.job_scope_rows ADD CONSTRAINT scope_row_custom_entry_source CHECK (is_custom_entry = (factor_source = 'client'));

CREATE FUNCTION nzi_console.enforce_scope_row_client_factor_boundary() RETURNS trigger
LANGUAGE plpgsql SET search_path = nzi_console, pg_temp AS $$
BEGIN
  IF NEW.factor_source = 'client' AND NOT EXISTS (
    SELECT 1 FROM nzi_console.client_factors cf
    JOIN nzi_console.jobs j ON (j.organisation_id,j.client_id)=(cf.organisation_id,cf.client_id)
    WHERE cf.organisation_id=NEW.organisation_id AND cf.client_factor_id=NEW.client_factor_id
      AND j.job_id=NEW.job_id AND (cf.job_id IS NULL OR cf.job_id=NEW.job_id) AND cf.archived=false
  ) THEN RAISE EXCEPTION 'Client factor is outside the scope row job boundary' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scope_row_client_factor_boundary
BEFORE INSERT OR UPDATE OF job_id,factor_source,client_factor_id ON nzi_console.job_scope_rows
FOR EACH ROW EXECUTE FUNCTION nzi_console.enforce_scope_row_client_factor_boundary();

ALTER TABLE nzi_console.client_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_factors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_factors USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.client_factors TO nzi_console_app;
GRANT EXECUTE ON FUNCTION nzi_console.enforce_client_factor_job_boundary() TO nzi_console_app;
GRANT EXECUTE ON FUNCTION nzi_console.enforce_scope_row_client_factor_boundary() TO nzi_console_app;

COMMIT;
