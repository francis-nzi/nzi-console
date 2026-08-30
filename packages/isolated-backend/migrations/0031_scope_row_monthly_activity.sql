BEGIN;

ALTER TABLE nzi_console.job_scope_rows
  ADD COLUMN monthly_activity_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT job_scope_rows_monthly_activity_array CHECK (jsonb_typeof(monthly_activity_json) = 'array');

COMMENT ON COLUMN nzi_console.job_scope_rows.monthly_activity_json IS
  'Optional reporting-period-aligned [{month: YYYY-MM, quantity: number|null}] vector; annual quantity is derived when populated.';

COMMIT;
