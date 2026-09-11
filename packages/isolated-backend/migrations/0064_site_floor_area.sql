BEGIN;

-- NZC-071 — site floor area is effective-dated and append-only; the per-m²
-- intensity denominator is the sum of the in-boundary sites' floor area for a
-- job's reporting period. A correction is a new record, never an edit.
CREATE TABLE nzi_console.client_site_floor_areas (
  organisation_id text NOT NULL,
  floor_area_id text NOT NULL,
  site_id text NOT NULL,
  effective_from date,
  floor_area_m2 numeric(14,2) NOT NULL CHECK (floor_area_m2 > 0),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, floor_area_id),
  FOREIGN KEY (organisation_id, site_id) REFERENCES nzi_console.client_sites(organisation_id, site_id) ON DELETE CASCADE
);
COMMENT ON COLUMN nzi_console.client_site_floor_areas.effective_from IS 'First day this floor area applies. NULL = from the site''s start. The record in force at a period end is the one used.';
CREATE INDEX client_site_floor_areas_site_idx ON nzi_console.client_site_floor_areas (organisation_id, site_id, effective_from);

ALTER TABLE nzi_console.client_site_floor_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_site_floor_areas FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_site_floor_areas
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT ON nzi_console.client_site_floor_areas TO nzi_console_app;

-- The typed denominator is deprecated for the floor-area metric: it is derived
-- from the sites, so a floor-area target stores NULL. Values already typed are
-- kept for the record but no longer read. Turnover and headcount still need one.
ALTER TABLE nzi_console.job_intensity_targets
  ALTER COLUMN reporting_denominator DROP NOT NULL,
  DROP CONSTRAINT job_intensity_targets_reporting_denominator_check,
  ADD CONSTRAINT job_intensity_targets_reporting_denominator_check
  CHECK (reporting_denominator IS NULL OR reporting_denominator > 0),
  ADD CONSTRAINT job_intensity_targets_typed_denominator_required
  CHECK (metric = 'floor-area' OR reporting_denominator IS NOT NULL);
COMMENT ON COLUMN nzi_console.job_intensity_targets.reporting_denominator IS 'Typed denominator for turnover / headcount. Ignored for floor-area, which is derived from client_site_floor_areas (NZC-071).';

COMMIT;
