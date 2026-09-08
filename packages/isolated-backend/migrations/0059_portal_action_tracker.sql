-- A2-lite: client-managed qualitative action tracking, separate from emissions data.
CREATE TABLE nzi_console.portal_tracker_actions (
  organisation_id text NOT NULL,
  action_id text NOT NULL,
  client_id text NOT NULL,
  job_id text NOT NULL,
  lever_code text NOT NULL,
  title text NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 240),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 4000),
  progress_percent integer NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, action_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, job_id, client_id) REFERENCES nzi_console.jobs(organisation_id, job_id, client_id) ON DELETE CASCADE
);
CREATE INDEX portal_tracker_actions_job_idx ON nzi_console.portal_tracker_actions(organisation_id,client_id,job_id,lever_code);
ALTER TABLE nzi_console.portal_tracker_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.portal_tracker_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.portal_tracker_actions USING (organisation_id=nzi_console.current_organisation_id()) WITH CHECK (organisation_id=nzi_console.current_organisation_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON nzi_console.portal_tracker_actions TO nzi_console_app;
COMMENT ON TABLE nzi_console.portal_tracker_actions IS 'A2-lite client-managed engagement actions. Qualitative only: no emissions quantities, factors, reductions, projections, or write-back to reported figures.';
