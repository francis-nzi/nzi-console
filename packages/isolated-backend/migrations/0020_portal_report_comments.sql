BEGIN;

CREATE TABLE nzi_console.portal_report_comments (
  organisation_id text NOT NULL,
  comment_id text NOT NULL,
  report_version_id text NOT NULL,
  job_id text NOT NULL,
  client_id text NOT NULL,
  parent_comment_id text,
  author_principal text NOT NULL CHECK (author_principal IN ('portal','staff')),
  author_id text NOT NULL,
  author_display_name text NOT NULL,
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id,comment_id),
  FOREIGN KEY (organisation_id,report_version_id) REFERENCES nzi_console.report_versions(organisation_id,report_version_id),
  FOREIGN KEY (organisation_id,job_id) REFERENCES nzi_console.jobs(organisation_id,job_id),
  FOREIGN KEY (organisation_id,client_id) REFERENCES nzi_console.clients(organisation_id,client_id),
  FOREIGN KEY (organisation_id,parent_comment_id) REFERENCES nzi_console.portal_report_comments(organisation_id,comment_id)
);

CREATE INDEX portal_report_comments_thread_idx ON nzi_console.portal_report_comments(organisation_id,report_version_id,created_at);
ALTER TABLE nzi_console.portal_report_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.portal_report_comments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.portal_report_comments USING (organisation_id=current_setting('app.organisation_id',true)) WITH CHECK (organisation_id=current_setting('app.organisation_id',true));
GRANT SELECT,INSERT ON nzi_console.portal_report_comments TO nzi_console_app;
REVOKE UPDATE,DELETE ON nzi_console.portal_report_comments FROM PUBLIC,nzi_console_app,nzi_console_worker;

COMMIT;
