BEGIN;

-- Job-family model batch, Phase 0 — Consultancy (MODEL_FIDELITY_JOB_FAMILIES.md
-- §4; NZC-056). The lightest family: live is a single job_consultancy_details
-- row. Deliberately NO time-tracking engine — hours are a budget/used pair on
-- the detail row, and the only "detail grid" is a deliverable checklist.
-- Additive, inert until a consultancy module reads it.

CREATE TABLE nzi_console.job_consultancy_details (
  organisation_id text NOT NULL,
  job_id text NOT NULL,
  engagement_type text NOT NULL DEFAULT 'advisory' CHECK (engagement_type IN ('advisory','retainer','fixed_scope','workshop','audit')),
  scope text NOT NULL DEFAULT '',
  hours_budget numeric CHECK (hours_budget IS NULL OR hours_budget >= 0),
  hours_used numeric NOT NULL DEFAULT 0 CHECK (hours_used >= 0),
  next_review_date date,
  summary_notes text NOT NULL DEFAULT '',
  workflow_stage_key text NOT NULL DEFAULT 'scope' CHECK (workflow_stage_key IN ('scope','plan','delivery','client_review','complete')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved','rejected')),
  reviewed_version integer,
  reviewed_by text,
  reviewed_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz,
  PRIMARY KEY (organisation_id, job_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id) ON DELETE CASCADE,
  CONSTRAINT job_consultancy_reviewed_shape CHECK ((review_status = 'pending') = (reviewed_version IS NULL))
);
ALTER TABLE nzi_console.job_consultancy_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.job_consultancy_details FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.job_consultancy_details USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.job_consultancy_details TO nzi_console_app;

CREATE TABLE nzi_console.consultancy_deliverables (
  organisation_id text NOT NULL,
  deliverable_id text NOT NULL,
  job_id text NOT NULL,
  title text NOT NULL CHECK (nullif(trim(title), '') IS NOT NULL),
  description text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','delivered','accepted','rejected')),
  due_date date,
  delivered_at timestamptz,
  accepted_at timestamptz,
  rework_note text,
  file_id text,
  report_version_id text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz,
  PRIMARY KEY (organisation_id, deliverable_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, report_version_id) REFERENCES nzi_console.report_versions(organisation_id, report_version_id) ON DELETE SET NULL,
  CONSTRAINT consultancy_deliverable_delivered_shape CHECK (status NOT IN ('delivered','accepted') OR delivered_at IS NOT NULL),
  CONSTRAINT consultancy_deliverable_accepted_shape CHECK ((status = 'accepted') = (accepted_at IS NOT NULL)),
  CONSTRAINT consultancy_deliverable_rework_shape CHECK ((status = 'rejected') = (rework_note IS NOT NULL))
);
CREATE INDEX consultancy_deliverables_job_idx ON nzi_console.consultancy_deliverables(organisation_id, job_id, status, sort_order);
ALTER TABLE nzi_console.consultancy_deliverables ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.consultancy_deliverables FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.consultancy_deliverables USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON nzi_console.consultancy_deliverables TO nzi_console_app;

COMMENT ON TABLE nzi_console.job_consultancy_details IS 'One versioned row per consultancy job (NZC-056). hours_budget/hours_used is a simple pair — no time-log table.';
COMMENT ON TABLE nzi_console.consultancy_deliverables IS 'The consultancy module''s only detail grid: a deliverable checklist. status planned→in_progress→delivered→accepted, or rejected (rework_note required).';

COMMIT;
