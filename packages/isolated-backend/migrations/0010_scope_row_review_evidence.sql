BEGIN;

ALTER TABLE nzi_console.job_scope_rows
  ADD COLUMN reviewed_row_version integer,
  ADD COLUMN reviewed_by text,
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN reviewer_note text;

UPDATE nzi_console.job_scope_rows SET reviewed_row_version=version,reviewed_by='migration:legacy-review',reviewed_at=updated_at,
  reviewer_note=CASE WHEN review_status='rejected' THEN 'Legacy rejected state migrated without original reviewer note.' ELSE reviewer_note END
WHERE review_status IN ('approved','rejected');

ALTER TABLE nzi_console.job_scope_rows
  ADD CONSTRAINT scope_row_review_evidence CHECK (
    (review_status='pending' AND reviewed_row_version IS NULL AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (review_status IN ('approved','rejected') AND reviewed_row_version IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  ADD CONSTRAINT scope_row_rejection_note CHECK (review_status<>'rejected' OR nullif(trim(reviewer_note),'') IS NOT NULL);

CREATE TABLE nzi_console.scope_row_review_history (
  organisation_id text NOT NULL,
  review_event_id text NOT NULL,
  job_id text NOT NULL,
  scope_row_id text NOT NULL,
  row_version integer NOT NULL CHECK (row_version>0),
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  reviewer_id text NOT NULL,
  reviewer_note text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id,review_event_id),
  FOREIGN KEY (organisation_id,job_id) REFERENCES nzi_console.jobs(organisation_id,job_id),
  FOREIGN KEY (organisation_id,scope_row_id) REFERENCES nzi_console.job_scope_rows(organisation_id,scope_row_id),
  CHECK (decision<>'rejected' OR nullif(trim(reviewer_note),'') IS NOT NULL)
);

ALTER TABLE nzi_console.scope_row_review_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.scope_row_review_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.scope_row_review_history USING (organisation_id=current_setting('app.organisation_id',true)) WITH CHECK (organisation_id=current_setting('app.organisation_id',true));
GRANT SELECT,INSERT ON nzi_console.scope_row_review_history TO nzi_console_app;
REVOKE UPDATE,DELETE ON nzi_console.scope_row_review_history FROM nzi_console_app;

COMMIT;
