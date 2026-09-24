-- 0118 Suspending a portal user's credentials is a boundary the application calls, not a table it writes
-- (P0b).
--
-- ## What was wrong
--
-- `createPortalRecoveryInvitation` suspended a user's credentials and revoked their sessions by UPDATEing
-- `portal_credentials` and `portal_sessions` directly. 0018 grants both tables to `nzi_console_auth` alone
-- — the application role is deliberately kept off them — so as the role it runs as, recovery was refused on
-- its first write and could never be issued. Nothing noticed, because its only tests ran against a fake pool.
--
-- Sessions already had the right shape: `revoke_portal_user_sessions` (0024), a confined definer function
-- the application may execute. Credentials had none, so there was no least-privilege way to write what
-- recovery needs. This adds it, in 0024's shape exactly, and recovery calls the two functions instead of the
-- tables.
--
-- ## Confined, and to what
--
--   * **One tenant.** It refuses unless the organisation it is asked about is the transaction's own
--     `app.organisation_id` — the same check 0024 makes, so a caller cannot suspend another tenant's user by
--     naming them.
--   * **One direction, one column.** It sets `enabled = false` and nothing else. It cannot enable, cannot
--     read or return a password hash or a TOTP secret, and cannot change which user the row belongs to.
--     Enabling stays where it is: inside the invitation-completion path, under `nzi_console_auth`.
--   * **One caller.** EXECUTE is revoked from PUBLIC and granted to `nzi_console_app` only.
--
-- Owned by whoever applies migrations, as 0024's sibling is. These tables carry no row-level security — they
-- are protected by grants — so the owner's own table privileges are what the function uses, and no
-- `BYPASSRLS` is being relied on. It is **not** given to `nzi_console_definer`: that role's ownership list is
-- its cross-tenant boundary (0104), and a tenant-scoped write does not belong in it.

BEGIN;

CREATE FUNCTION nzi_console.suspend_portal_user_credentials(p_organisation_id text, p_portal_user_id text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = nzi_console, pg_temp AS $$
DECLARE affected integer;
BEGIN
  IF p_organisation_id IS DISTINCT FROM current_setting('app.organisation_id', true) THEN
    RAISE EXCEPTION 'Tenant context mismatch';
  END IF;
  UPDATE portal_credentials SET enabled = false
   WHERE organisation_id = p_organisation_id AND portal_user_id = p_portal_user_id AND enabled;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END $$;

REVOKE ALL ON FUNCTION nzi_console.suspend_portal_user_credentials(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nzi_console.suspend_portal_user_credentials(text, text) TO nzi_console_app;

COMMENT ON FUNCTION nzi_console.suspend_portal_user_credentials(text, text) IS
  'Sets enabled=false on one portal user''s credentials, in the calling tenant only. The application''s only write path to portal_credentials: it may suspend, never enable, and never reads the secrets beside the flag (P0b).';

COMMIT;
