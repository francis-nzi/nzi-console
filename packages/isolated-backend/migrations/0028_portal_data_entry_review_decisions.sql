BEGIN;

ALTER TABLE nzi_console.portal_data_entry_review_queue
  ADD COLUMN reviewed_by text,
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN review_note text;

ALTER TABLE nzi_console.portal_data_entry_review_queue
  ADD CONSTRAINT portal_data_entry_review_completion
  CHECK ((status='pending' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR (status IN ('accepted','rejected') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  ADD CONSTRAINT portal_data_entry_rejection_note
  CHECK (status<>'rejected' OR nullif(trim(review_note),'') IS NOT NULL);

COMMIT;
