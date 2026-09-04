BEGIN;

-- NZC-063 — previous-year rollforward generalised to every job_scope_rows type
-- (not just the spend register, which already has this via
-- job_emission_sources.rolled_forward_from_source_id, migration 0039). A row
-- created by copying a prior reporting year's canonical row forward records
-- which prior row it came from, so the rollforward is idempotent (one copy
-- per origin per job) and the origin is auditable.
ALTER TABLE nzi_console.job_scope_rows ADD COLUMN rolled_forward_from_row_id text;

ALTER TABLE nzi_console.job_scope_rows
  ADD CONSTRAINT scope_row_rollforward_origin_fk
  FOREIGN KEY (organisation_id, rolled_forward_from_row_id)
  REFERENCES nzi_console.job_scope_rows(organisation_id, scope_row_id);

-- One rolled-forward copy of a given prior row per target job.
CREATE UNIQUE INDEX job_scope_rows_one_rollforward_per_origin_idx
  ON nzi_console.job_scope_rows(organisation_id, job_id, rolled_forward_from_row_id)
  WHERE rolled_forward_from_row_id IS NOT NULL;

COMMENT ON COLUMN nzi_console.job_scope_rows.rolled_forward_from_row_id IS
  'Prior reporting year''s job_scope_rows.scope_row_id this row was rolled forward from (NZC-063).';

COMMIT;
