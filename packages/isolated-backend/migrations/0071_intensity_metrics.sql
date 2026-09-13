BEGIN;

-- Intensity metrics — defined on the client, recorded on the job.
--
-- Until now the bases were hard-coded (turnover / employees / floor area). A client's
-- meaningful denominator is its own business: vehicles, beds, meals, units produced. So
-- the SET is a client-level definition, and the VALUES are captured per reporting year on
-- the job that reports that year.
--
-- Employees and Turnover are standard for every client — seeded here, deactivatable but
-- never removable, with editable unit wording and divider. Anything else is an additional
-- the client adds.
--
-- Each definition carries a Per-N divider and an icon KEY (not an image): intensity reads
-- "tCO2e per 1,000 employees", and the icon is resolved from the key by whichever curated
-- print-safe set is in force, so the set can change without touching this data.
--
-- Definitions are versioned and append-only: a change writes the next version and the one
-- before it stays readable, so a historical report keeps the wording and divider it was
-- issued with.

CREATE TABLE nzi_console.client_intensity_metrics (
  organisation_id text NOT NULL,
  client_id text NOT NULL,
  metric_key text NOT NULL CHECK (metric_key = lower(metric_key) AND metric_key ~ '^[a-z0-9][a-z0-9_-]*$'),
  version integer NOT NULL CHECK (version > 0),

  label text NOT NULL CHECK (label = trim(label) AND label <> ''),
  /* The noun the denominator counts: "employee", "£m", "m²", "vehicle". */
  unit_wording text NOT NULL CHECK (unit_wording = trim(unit_wording) AND unit_wording <> ''),
  /* Per-N: the intensity is emissions x divider / value, so "per 1,000 employees". */
  divider integer NOT NULL DEFAULT 1 CHECK (divider IN (1, 10, 100, 1000, 10000, 100000, 1000000)),
  /* A key into the curated icon set, resolved at render time — never an image or an emoji. */
  icon_key text NOT NULL DEFAULT 'metric' CHECK (icon_key = lower(icon_key) AND icon_key ~ '^[a-z][a-z0-9-]*$'),
  /* Employees and Turnover: always present, never removable, only deactivatable. */
  is_standard boolean NOT NULL DEFAULT false,
  /* Where the annual value comes from: typed on the job, or resolved from the client's
     own effective-dated site floor areas (NZC-071). */
  value_source text NOT NULL DEFAULT 'entered' CHECK (value_source IN ('entered', 'site-floor-area')),
  active boolean NOT NULL DEFAULT true,
  ordering integer NOT NULL DEFAULT 0,

  set_by text NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text NOT NULL,

  PRIMARY KEY (organisation_id, client_id, metric_key, version),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id)
);
CREATE INDEX client_intensity_metrics_current_idx ON nzi_console.client_intensity_metrics (organisation_id, client_id, metric_key, version DESC);

-- The annual values. One row per job x reporting year x metric.
--
-- `period_key` is the seam for the time dimension Francis has flagged: today every row is
-- 'year', the whole reporting year. When monthly or quarterly capture arrives it becomes
-- '2024-03' or '2024-Q1' alongside the annual row, and nothing about this table reshapes —
-- the annual figure stays the one the intensity resolver reads unless asked otherwise.
CREATE TABLE nzi_console.job_intensity_values (
  organisation_id text NOT NULL,
  job_id text NOT NULL,
  reporting_year integer NOT NULL CHECK (reporting_year BETWEEN 2000 AND 2100),
  metric_key text NOT NULL,
  period_key text NOT NULL DEFAULT 'year' CHECK (period_key = 'year' OR period_key ~ '^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$'),

  /* null = not recorded for this year; the metric then reads "unavailable", never zero. */
  value numeric(18,4) CHECK (value IS NULL OR value >= 0),
  /* An override of a value the platform resolved itself (floor area from the sites). */
  overrides_resolved boolean NOT NULL DEFAULT false,
  note text NOT NULL DEFAULT '',

  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (organisation_id, job_id, reporting_year, metric_key, period_key),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id) ON DELETE CASCADE
);
CREATE INDEX job_intensity_values_year_idx ON nzi_console.job_intensity_values (organisation_id, job_id, reporting_year, period_key);

ALTER TABLE nzi_console.client_intensity_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_intensity_metrics FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_intensity_metrics
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

ALTER TABLE nzi_console.job_intensity_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.job_intensity_values FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.job_intensity_values
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

-- A definition change is a new version; a value correction is a new version of that row.
GRANT SELECT, INSERT ON nzi_console.client_intensity_metrics TO nzi_console_app;
REVOKE UPDATE, DELETE ON nzi_console.client_intensity_metrics FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;
GRANT SELECT, INSERT, UPDATE ON nzi_console.job_intensity_values TO nzi_console_app;
REVOKE DELETE ON nzi_console.job_intensity_values FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

-- Every client starts with the standard pair. Turnover's divider follows the live system's
-- convention of reporting per £m; employees are per head until someone says otherwise.
INSERT INTO nzi_console.client_intensity_metrics
  (organisation_id, client_id, metric_key, version, label, unit_wording, divider, icon_key, is_standard, value_source, ordering, set_by, correlation_id)
SELECT c.organisation_id, c.client_id, v.metric_key, 1, v.label, v.unit_wording, v.divider, v.icon_key, true, 'entered', v.ordering, 'migration:0071', 'migration:0071'
FROM nzi_console.clients c,
  (VALUES
    ('employees', 'Employees', 'employee', 1, 'people', 1),
    ('turnover', 'Turnover', '£m', 1000000, 'currency', 2)
  ) AS v(metric_key, label, unit_wording, divider, icon_key, ordering);

-- Floor area is only meaningful for a client that records site floor areas, so it is added
-- as an additional exactly where that is already true — resolved from the in-service sites
-- for each reporting year (NZC-071) rather than typed on the job.
INSERT INTO nzi_console.client_intensity_metrics
  (organisation_id, client_id, metric_key, version, label, unit_wording, divider, icon_key, is_standard, value_source, ordering, set_by, correlation_id)
SELECT DISTINCT s.organisation_id, s.client_id, 'floor-area', 1, 'Floor area', 'm²', 1, 'building', false, 'site-floor-area', 3, 'migration:0071', 'migration:0071'
FROM nzi_console.client_sites s
JOIN nzi_console.client_site_floor_areas a ON (a.organisation_id, a.site_id) = (s.organisation_id, s.site_id);

-- Carry across the annual values the job-level intensity targets already hold, so no
-- client loses a denominator they had recorded. Only the typed ones: a floor-area
-- denominator is resolved from the sites, not copied.
INSERT INTO nzi_console.job_intensity_values
  (organisation_id, job_id, reporting_year, metric_key, period_key, value, note, recorded_by)
SELECT t.organisation_id, t.job_id, j.reporting_year,
  CASE t.metric WHEN 'turnover' THEN 'turnover' WHEN 'employee' THEN 'employees' END,
  'year', t.reporting_denominator,
  'Carried across from the job intensity target by migration 0071.', 'migration:0071'
FROM nzi_console.job_intensity_targets t
JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (t.organisation_id, t.job_id)
WHERE t.metric IN ('turnover', 'employee')
  AND t.reporting_denominator IS NOT NULL
  AND j.reporting_year IS NOT NULL
ON CONFLICT DO NOTHING;

COMMIT;
