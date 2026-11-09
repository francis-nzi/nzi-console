-- 0219 Employee commuting (3.7): per-site headcount and sample uplift (BRIEF-commuting-uplift-lean, ruled 8 Nov).
--
-- Commuting is captured as a sample (one scope row per respondent). To extrapolate a site's sample to its workforce the job needs, per
-- site, the headcount (E), the wholly-company-car staff (C) whose commute is already Scope 1/2, the per-site uplift toggle (default OFF)
-- and the uplift headcount the client agreed (NULL = take the computed default). The uplift itself is derived at the figure that locks
-- (the snapshot); this table holds only what people entered, and the stored scope rows are never touched by it.
--
-- Also: commuting rows now carry the site they belong to (job_scope_rows.site_id has existed since 0013). The backfill assigns a null-site
-- 3.7 row only where there is no ambiguity - its client has exactly one site. Multi-site null-site rows stay null: uplift excludes them
-- and the CRM is told to assign them. Nothing is bucketed silently.
BEGIN;

CREATE TABLE nzi_console.job_site_headcount (
  organisation_id text NOT NULL,
  job_id text NOT NULL,
  site_id text NOT NULL,
  employees integer NOT NULL CHECK (employees >= 0),
  company_car_users integer NOT NULL DEFAULT 0 CHECK (company_car_users >= 0),
  uplift_enabled boolean NOT NULL DEFAULT false,
  agreed_uplift_headcount integer CHECK (agreed_uplift_headcount IS NULL OR agreed_uplift_headcount >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  saved_in_portal boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  PRIMARY KEY (organisation_id, job_id, site_id),
  CHECK (company_car_users <= employees),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id),
  FOREIGN KEY (organisation_id, site_id) REFERENCES nzi_console.client_sites(organisation_id, site_id)
);
COMMENT ON TABLE nzi_console.job_site_headcount IS
  'Commuting uplift: per job and site, the employees (E), wholly-company-car staff (C), the per-site uplift toggle (default off) and the agreed uplift headcount (null = computed default). Inputs only; the uplift is derived at the figure that locks.';

ALTER TABLE nzi_console.job_site_headcount ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.job_site_headcount FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.job_site_headcount
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.job_site_headcount TO nzi_console_app;
REVOKE DELETE ON nzi_console.job_site_headcount FROM nzi_console_app, PUBLIC;

-- Backfill: a live 3.7 row with no site, on a job whose client has exactly one site, belongs to that site. `version` is not bumped, so an
-- approved row's reviewed_row_version still matches it; migrated history is untouched (its trigger would refuse it, and it is not live).
UPDATE nzi_console.job_scope_rows r
   SET site_id = only_site.site_id
  FROM nzi_console.jobs j
  JOIN (
    SELECT organisation_id, client_id, min(site_id) AS site_id
      FROM nzi_console.client_sites
     GROUP BY organisation_id, client_id
    HAVING count(*) = 1
  ) only_site ON (only_site.organisation_id, only_site.client_id) = (j.organisation_id, j.client_id)
 WHERE (j.organisation_id, j.job_id) = (r.organisation_id, r.job_id)
   AND r.scope = '3.7' AND r.site_id IS NULL AND r.origin = 'live';

COMMIT;
