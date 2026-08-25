BEGIN;

CREATE TABLE nzi_console.portal_report_thread_reads (
  organisation_id text NOT NULL,
  report_version_id text NOT NULL,
  portal_user_id text NOT NULL,
  last_read_at timestamptz NOT NULL,
  PRIMARY KEY (organisation_id,report_version_id,portal_user_id),
  FOREIGN KEY (organisation_id,report_version_id) REFERENCES nzi_console.report_versions(organisation_id,report_version_id),
  FOREIGN KEY (organisation_id,portal_user_id) REFERENCES nzi_console.portal_users(organisation_id,portal_user_id)
);

ALTER TABLE nzi_console.portal_report_thread_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.portal_report_thread_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.portal_report_thread_reads USING (organisation_id=current_setting('app.organisation_id',true)) WITH CHECK (organisation_id=current_setting('app.organisation_id',true));
GRANT SELECT,INSERT,UPDATE ON nzi_console.portal_report_thread_reads TO nzi_console_app;
REVOKE DELETE ON nzi_console.portal_report_thread_reads FROM PUBLIC,nzi_console_app,nzi_console_worker;

COMMIT;
