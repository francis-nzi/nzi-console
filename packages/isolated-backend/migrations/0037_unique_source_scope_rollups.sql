BEGIN;

CREATE UNIQUE INDEX job_scope_rows_one_rollup_per_source_idx
  ON nzi_console.job_scope_rows(organisation_id, source_id)
  WHERE source_id IS NOT NULL;

COMMIT;
