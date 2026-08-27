BEGIN;

CREATE TABLE nzi_console.portal_data_entry_bucket_grants (
  organisation_id text NOT NULL,
  bucket_grant_id text NOT NULL,
  access_grant_id text NOT NULL,
  scope_row_id text NOT NULL,
  allowed_factor_ids text[] NOT NULL CHECK (cardinality(allowed_factor_ids)>0),
  allowed_site_ids text[] NOT NULL DEFAULT '{}',
  allowed_units text[] NOT NULL CHECK (cardinality(allowed_units)>0),
  revoked_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id,bucket_grant_id),
  UNIQUE (organisation_id,access_grant_id,scope_row_id),
  FOREIGN KEY (organisation_id,access_grant_id) REFERENCES nzi_console.portal_access_grants(organisation_id,grant_id),
  FOREIGN KEY (organisation_id,scope_row_id) REFERENCES nzi_console.job_scope_rows(organisation_id,scope_row_id)
);

ALTER TABLE nzi_console.portal_data_entry_bucket_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.portal_data_entry_bucket_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.portal_data_entry_bucket_grants USING (organisation_id=current_setting('app.organisation_id',true)) WITH CHECK (organisation_id=current_setting('app.organisation_id',true));
GRANT SELECT,INSERT,UPDATE ON nzi_console.portal_data_entry_bucket_grants TO nzi_console_app;
REVOKE DELETE ON nzi_console.portal_data_entry_bucket_grants FROM PUBLIC,nzi_console_app,nzi_console_worker,nzi_console_auth;

COMMIT;
