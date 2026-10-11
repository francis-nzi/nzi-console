BEGIN;

-- The v7 re-ingest commit phase (RULING-v7-allocation-decisions step 3; DESIGN-v7-reingest-commit-phase, ruled in
-- REVIEW-v7-reingest-commit-phase). An imported job's v7 rows are re-written as new live console rows — never by mutating
-- the v7 rows, which 0133 keeps immutable — and the v7 rows they replace are switched off, so nothing is counted twice.
-- This migration holds the two records that make that auditable and idempotent; it moves no row.

-- 1. Which v7 row a live row was re-ingested from (the shape of 0055's rolled_forward_from_row_id). One enabled
-- re-ingested copy per v7 row per job: a reverted run's rows are switched off, never deleted, so a later run may
-- link the same v7 row again. A re-ingested row is always live — it is the console's row, not history.
ALTER TABLE nzi_console.job_scope_rows ADD COLUMN reingested_from_row_id text;

ALTER TABLE nzi_console.job_scope_rows
  ADD CONSTRAINT scope_row_reingest_origin_fk
  FOREIGN KEY (organisation_id, reingested_from_row_id)
  REFERENCES nzi_console.job_scope_rows(organisation_id, scope_row_id);

ALTER TABLE nzi_console.job_scope_rows
  ADD CONSTRAINT job_scope_rows_reingest_is_live CHECK (reingested_from_row_id IS NULL OR origin = 'live');

CREATE UNIQUE INDEX job_scope_rows_one_reingest_per_origin_idx
  ON nzi_console.job_scope_rows(organisation_id, job_id, reingested_from_row_id)
  WHERE reingested_from_row_id IS NOT NULL AND enabled;

COMMENT ON COLUMN nzi_console.job_scope_rows.reingested_from_row_id IS
  'The migrated v7 job_scope_rows.scope_row_id this live row was re-ingested from (v7 re-ingest, 0166).';

-- 2. One row per re-ingest run of a job: the crosswalk it applied, what it reconciled to (tCO2e only — no money,
-- NZC-120), and whether it was later reverted. At most one completed run per job. The snapshot gate reads it: a job
-- whose v7 rows are all switched off by a completed run may be frozen; any other imported job is refused as before.
CREATE TABLE nzi_console.v7_reingest_runs (
  organisation_id text NOT NULL,
  run_id text NOT NULL CHECK (run_id ~ '^v7-reingest-[0-9a-f-]{36}$'),
  job_id text NOT NULL,
  crosswalk_version text NOT NULL CHECK (crosswalk_version = btrim(crosswalk_version) AND crosswalk_version <> ''),
  crosswalk_sha256 text NOT NULL CHECK (crosswalk_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'reverted')),
  v7_total_tco2e numeric(16,6) NOT NULL,
  native_total_tco2e numeric(16,6) NOT NULL,
  scope_totals_json jsonb NOT NULL CHECK (jsonb_typeof(scope_totals_json) = 'object'),
  rows_by_disposition_json jsonb NOT NULL CHECK (jsonb_typeof(rows_by_disposition_json) = 'object'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text NOT NULL,
  reverted_by text,
  reverted_at timestamptz,
  revert_reason text CHECK (revert_reason IS NULL OR (revert_reason = btrim(revert_reason) AND revert_reason <> '')),
  PRIMARY KEY (organisation_id, run_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id),
  CONSTRAINT v7_reingest_runs_revert_shape CHECK (
    (status = 'reverted') = (reverted_by IS NOT NULL AND reverted_at IS NOT NULL AND revert_reason IS NOT NULL))
);
CREATE UNIQUE INDEX v7_reingest_runs_one_completed_per_job_idx
  ON nzi_console.v7_reingest_runs (organisation_id, job_id) WHERE status = 'completed';

ALTER TABLE nzi_console.v7_reingest_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.v7_reingest_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.v7_reingest_runs
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
-- Written once; the only later change is the revert stamp. Never deleted.
GRANT SELECT, INSERT ON nzi_console.v7_reingest_runs TO nzi_console_app;
GRANT UPDATE (status, reverted_by, reverted_at, revert_reason) ON nzi_console.v7_reingest_runs TO nzi_console_app;
REVOKE DELETE ON nzi_console.v7_reingest_runs FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

COMMIT;
