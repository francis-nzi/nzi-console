BEGIN;
SET search_path TO nzi_console, public;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nzi_console_app') THEN
    CREATE ROLE nzi_console_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nzi_console_worker') THEN
    CREATE ROLE nzi_console_worker NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA nzi_console TO nzi_console_app, nzi_console_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA nzi_console TO nzi_console_app;
GRANT SELECT, INSERT, UPDATE ON nzi_console.transactional_outbox TO nzi_console_worker;
GRANT SELECT, INSERT ON nzi_console.audit_events TO nzi_console_worker;
REVOKE ALL ON nzi_console.job_number_counter FROM nzi_console_app, nzi_console_worker;
REVOKE ALL ON FUNCTION nzi_console.allocate_job_sequence() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nzi_console.allocate_job_sequence() TO nzi_console_app;
REVOKE DELETE ON nzi_console.audit_events FROM nzi_console_app, nzi_console_worker;
REVOKE UPDATE ON nzi_console.audit_events FROM nzi_console_app, nzi_console_worker;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'memberships','clients','jobs','job_stage_history','job_scope_rows','report_versions',
    'portal_access_grants','command_idempotency','audit_events','transactional_outbox'
  ] LOOP
    EXECUTE format('ALTER TABLE nzi_console.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE nzi_console.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON nzi_console.%I USING (organisation_id = current_setting(''app.organisation_id'', true)) WITH CHECK (organisation_id = current_setting(''app.organisation_id'', true))',
      table_name
    );
  END LOOP;
END $$;

ALTER DEFAULT PRIVILEGES IN SCHEMA nzi_console REVOKE ALL ON TABLES FROM PUBLIC;
REVOKE ALL ON SCHEMA nzi_console FROM PUBLIC;

COMMIT;
