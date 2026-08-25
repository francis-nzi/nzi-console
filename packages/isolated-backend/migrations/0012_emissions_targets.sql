BEGIN;

CREATE TABLE nzi_console.job_emissions_targets (
  organisation_id text NOT NULL,
  job_id text NOT NULL,
  baseline_year integer NOT NULL,
  baseline_tco2e numeric(20,6) NOT NULL CHECK (baseline_tco2e > 0),
  interim_year integer NOT NULL,
  interim_reduction_percent numeric(7,4) NOT NULL CHECK (interim_reduction_percent > 0 AND interim_reduction_percent < 100),
  net_zero_year integer NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id,job_id),
  FOREIGN KEY (organisation_id,job_id) REFERENCES nzi_console.jobs(organisation_id,job_id) ON DELETE CASCADE,
  CHECK (baseline_year < interim_year AND interim_year < net_zero_year)
);

ALTER TABLE nzi_console.job_emissions_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.job_emissions_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.job_emissions_targets USING (organisation_id=current_setting('app.organisation_id',true)) WITH CHECK (organisation_id=current_setting('app.organisation_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON nzi_console.job_emissions_targets TO nzi_console_app;

COMMIT;
