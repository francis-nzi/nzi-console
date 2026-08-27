BEGIN;

CREATE TABLE nzi_console.portal_data_entry_records (
  organisation_id text NOT NULL,
  record_id text NOT NULL,
  bucket_grant_id text NOT NULL,
  portal_user_id text NOT NULL,
  quantity numeric NOT NULL CHECK (quantity>0),
  unit text NOT NULL CHECK (nullif(trim(unit),'') IS NOT NULL),
  factor_id text NOT NULL CHECK (nullif(trim(factor_id),'') IS NOT NULL),
  site_id text,
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','deleted')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id,record_id),
  FOREIGN KEY (organisation_id,bucket_grant_id) REFERENCES nzi_console.portal_data_entry_bucket_grants(organisation_id,bucket_grant_id),
  FOREIGN KEY (organisation_id,portal_user_id) REFERENCES nzi_console.portal_users(organisation_id,portal_user_id),
  CHECK ((status='submitted')=(submitted_at IS NOT NULL))
);

CREATE TABLE nzi_console.portal_data_entry_review_queue (
  organisation_id text NOT NULL,
  queue_id text NOT NULL,
  record_id text NOT NULL,
  submitted_version integer NOT NULL CHECK (submitted_version>0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  submitted_at timestamptz NOT NULL,
  PRIMARY KEY (organisation_id,queue_id),
  UNIQUE (organisation_id,record_id),
  FOREIGN KEY (organisation_id,record_id) REFERENCES nzi_console.portal_data_entry_records(organisation_id,record_id)
);

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['portal_data_entry_records','portal_data_entry_review_queue'] LOOP
    EXECUTE format('ALTER TABLE nzi_console.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE nzi_console.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON nzi_console.%I USING (organisation_id=current_setting(''app.organisation_id'',true)) WITH CHECK (organisation_id=current_setting(''app.organisation_id'',true))',table_name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON nzi_console.%I TO nzi_console_app',table_name);
    EXECUTE format('REVOKE DELETE ON nzi_console.%I FROM PUBLIC,nzi_console_app,nzi_console_worker,nzi_console_auth',table_name);
  END LOOP;
END $$;

COMMIT;
