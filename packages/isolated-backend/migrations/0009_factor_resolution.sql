BEGIN;

CREATE TABLE nzi_console.emission_factor_datasets (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  dataset_id text NOT NULL,
  name text NOT NULL,
  version text NOT NULL,
  valid_from date NOT NULL,
  valid_to date NOT NULL,
  country_code text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','superseded','draft')),
  source_name text NOT NULL,
  licence text NOT NULL,
  synthetic boolean NOT NULL DEFAULT false,
  PRIMARY KEY (organisation_id,dataset_id),
  CHECK (valid_to >= valid_from)
);

CREATE TABLE nzi_console.emission_factors (
  organisation_id text NOT NULL,
  dataset_id text NOT NULL,
  factor_id text NOT NULL,
  label text NOT NULL,
  activity_unit text NOT NULL,
  kgco2e_per_unit numeric NOT NULL CHECK (kgco2e_per_unit >= 0),
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (organisation_id,dataset_id,factor_id),
  FOREIGN KEY (organisation_id,dataset_id) REFERENCES nzi_console.emission_factor_datasets(organisation_id,dataset_id)
);

CREATE TABLE nzi_console.job_emissions_config (
  organisation_id text NOT NULL,
  job_id text NOT NULL,
  reporting_from date NOT NULL,
  reporting_to date NOT NULL,
  country_code text NOT NULL DEFAULT 'GB',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (organisation_id,job_id),
  FOREIGN KEY (organisation_id,job_id) REFERENCES nzi_console.jobs(organisation_id,job_id),
  CHECK (reporting_to >= reporting_from)
);

CREATE TABLE nzi_console.job_dataset_selections (
  organisation_id text NOT NULL,
  job_id text NOT NULL,
  dataset_id text NOT NULL,
  selection_source text NOT NULL CHECK (selection_source IN ('automatic','manual')),
  reason text NOT NULL,
  warnings_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warnings_json)='array'),
  selected_by text NOT NULL,
  selected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id,job_id,dataset_id),
  FOREIGN KEY (organisation_id,job_id) REFERENCES nzi_console.jobs(organisation_id,job_id),
  FOREIGN KEY (organisation_id,dataset_id) REFERENCES nzi_console.emission_factor_datasets(organisation_id,dataset_id),
  CHECK (selection_source <> 'manual' OR nullif(trim(reason),'') IS NOT NULL)
);

INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
SELECT organisation_id,job_id,
  coalesce(make_date(reporting_year,1,1),start_date),
  coalesce(make_date(reporting_year,12,31),due_date),'GB'
FROM nzi_console.jobs WHERE job_family='crp';

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['emission_factor_datasets','emission_factors','job_emissions_config','job_dataset_selections'] LOOP
    EXECUTE format('ALTER TABLE nzi_console.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE nzi_console.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON nzi_console.%I USING (organisation_id=current_setting(''app.organisation_id'',true)) WITH CHECK (organisation_id=current_setting(''app.organisation_id'',true))',table_name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON nzi_console.%I TO nzi_console_app',table_name);
  END LOOP;
END $$;

COMMIT;
