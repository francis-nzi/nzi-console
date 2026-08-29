BEGIN;

ALTER TABLE nzi_console.job_scope_rows
  ADD COLUMN notes text,
  ADD CONSTRAINT job_scope_rows_notes_present CHECK (notes IS NULL OR nullif(trim(notes), '') IS NOT NULL);

COMMENT ON COLUMN nzi_console.job_scope_rows.notes IS
  'Consultant evidence notes carried with the versioned canonical row and reviewed snapshot.';

COMMIT;
