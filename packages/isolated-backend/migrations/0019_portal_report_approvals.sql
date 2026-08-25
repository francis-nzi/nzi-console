BEGIN;

CREATE TABLE nzi_console.portal_report_approvals (
  organisation_id text NOT NULL,
  approval_id text NOT NULL,
  report_version_id text NOT NULL,
  job_id text NOT NULL,
  portal_user_id text NOT NULL,
  client_id text NOT NULL,
  statement_version integer NOT NULL DEFAULT 1 CHECK (statement_version=1),
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id,approval_id),
  UNIQUE (organisation_id,report_version_id,portal_user_id),
  FOREIGN KEY (organisation_id,report_version_id) REFERENCES nzi_console.report_versions(organisation_id,report_version_id),
  FOREIGN KEY (organisation_id,job_id) REFERENCES nzi_console.jobs(organisation_id,job_id),
  FOREIGN KEY (organisation_id,portal_user_id,client_id) REFERENCES nzi_console.portal_users(organisation_id,portal_user_id,client_id)
);

ALTER TABLE nzi_console.portal_report_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.portal_report_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.portal_report_approvals USING (organisation_id=current_setting('app.organisation_id',true)) WITH CHECK (organisation_id=current_setting('app.organisation_id',true));
GRANT SELECT,INSERT ON nzi_console.portal_report_approvals TO nzi_console_app;
REVOKE UPDATE,DELETE ON nzi_console.portal_report_approvals FROM PUBLIC,nzi_console_app,nzi_console_worker;

COMMIT;
