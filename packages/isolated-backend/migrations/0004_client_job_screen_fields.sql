BEGIN;

ALTER TABLE nzi_console.clients
  ADD COLUMN sector text,
  ADD COLUMN location text,
  ADD COLUMN owner_name text,
  ADD COLUMN member_since integer,
  ADD COLUMN latest_footprint_tco2e numeric,
  ADD COLUMN yoy_percent numeric,
  ADD COLUMN completeness_percent integer CHECK (completeness_percent BETWEEN 0 AND 100),
  ADD COLUMN next_report_due_label text,
  ADD COLUMN contact_name text,
  ADD COLUMN contact_role text,
  ADD COLUMN contact_email text;

ALTER TABLE nzi_console.jobs
  ADD COLUMN reporting_year integer,
  ADD COLUMN owner_name text,
  ADD COLUMN start_date date,
  ADD COLUMN due_date date,
  ADD COLUMN quote_id text,
  ADD COLUMN progress_percent integer CHECK (progress_percent BETWEEN 0 AND 100),
  ADD COLUMN detail_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail_json) = 'object');

COMMIT;
