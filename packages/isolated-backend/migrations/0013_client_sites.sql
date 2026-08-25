BEGIN;

CREATE TABLE nzi_console.client_sites (
  organisation_id text NOT NULL,
  site_id text NOT NULL,
  client_id text NOT NULL,
  name text NOT NULL CHECK (nullif(trim(name),'') IS NOT NULL),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id,site_id),
  FOREIGN KEY (organisation_id,client_id) REFERENCES nzi_console.clients(organisation_id,client_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX client_sites_name_unique ON nzi_console.client_sites(organisation_id,client_id,lower(trim(name)));

ALTER TABLE nzi_console.job_scope_rows ADD COLUMN site_id text;
ALTER TABLE nzi_console.job_scope_rows ADD CONSTRAINT scope_row_site_fk FOREIGN KEY (organisation_id,site_id) REFERENCES nzi_console.client_sites(organisation_id,site_id);

ALTER TABLE nzi_console.client_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_sites FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_sites USING (organisation_id=current_setting('app.organisation_id',true)) WITH CHECK (organisation_id=current_setting('app.organisation_id',true));
GRANT SELECT,INSERT,UPDATE ON nzi_console.client_sites TO nzi_console_app;

COMMIT;
