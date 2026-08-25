BEGIN;

CREATE FUNCTION nzi_console.revoke_portal_user_sessions(p_organisation_id text,p_portal_user_id text,p_revoked_at timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=nzi_console,pg_temp AS $$
DECLARE affected integer;
BEGIN
  IF p_organisation_id IS DISTINCT FROM current_setting('app.organisation_id',true) THEN RAISE EXCEPTION 'Tenant context mismatch'; END IF;
  UPDATE portal_sessions SET revoked_at=coalesce(revoked_at,p_revoked_at)
  WHERE organisation_id=p_organisation_id AND portal_user_id=p_portal_user_id AND revoked_at IS NULL;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION nzi_console.revoke_portal_user_sessions(text,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nzi_console.revoke_portal_user_sessions(text,text,timestamptz) TO nzi_console_app;

COMMIT;
