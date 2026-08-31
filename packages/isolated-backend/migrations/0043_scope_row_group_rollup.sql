BEGIN;

-- S1 — group roll-up (NZC-043). A `job_emission_groups` group aggregates its
-- enabled member sources into ONE auto-generated canonical scope row, instead of
-- one row per source. The row pairs to the group by `group_id`; it is never
-- independently editable (edits happen on the member sources) and it recomputes
-- deterministically from the enabled members. Additive; inert until the group
-- sync command writes it.

ALTER TABLE nzi_console.job_scope_rows ADD COLUMN group_id text;
ALTER TABLE nzi_console.job_scope_rows
  ADD CONSTRAINT scope_row_group_fk
  FOREIGN KEY (organisation_id, group_id)
  REFERENCES nzi_console.job_emission_groups(organisation_id, group_id) ON DELETE SET NULL;

-- One roll-up row per group.
CREATE UNIQUE INDEX job_scope_rows_one_rollup_per_group_idx
  ON nzi_console.job_scope_rows(organisation_id, group_id)
  WHERE group_id IS NOT NULL;

-- A group roll-up row is always auto-generated and never also a per-source row.
ALTER TABLE nzi_console.job_scope_rows
  ADD CONSTRAINT scope_row_rollup_shape
  CHECK (group_id IS NULL OR (is_auto_generated = true AND source_id IS NULL));

-- A group carries the factor its members roll up onto (columns exist from 0036;
-- S1 starts issuing them).
COMMENT ON COLUMN nzi_console.job_scope_rows.group_id IS
  'When set, this canonical row is the auto-generated roll-up of job_emission_groups(group_id) (NZC-043); not independently editable.';

COMMIT;
