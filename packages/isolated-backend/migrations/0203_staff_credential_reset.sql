-- 0203 Resetting an enrolled member's sign-in (matrix v11, `staff.credential.reset`).
--
-- ## Why
--
-- An enrolled member who loses their authenticator had no Admin route back in: `staff.invite` refuses an enrolled member, a
-- password reset leaves MFA unchanged, and nothing could replace an authenticator. This is that route.
--
-- ## What it adds
--
-- **`nzi_console.reset_staff_credential(organisation, user, at)`** — a confined definer function, in the shape of 0199's
-- `revoke_client_portal_sessions`. The credential tables belong to the authentication role alone (0006), so the console role
-- that runs the Admin's command reaches them only through this. Tenant-confined, executable by the application role only,
-- and it does exactly four things to one staff member, returning counts and never a secret:
--
--   1. **Disables the credential** (`enabled = false`; failed attempts and lock cleared). Deactivate, not delete: the row, its
--      history and every foreign key to it stay. A disabled credential cannot sign in (login and the MFA step both require
--      `enabled`), and enrolment already replaces a disabled one (0129), so the fresh invitation is redeemed over it.
--   2. **Ends every session** (`staff_sessions.revoked_at`).
--   3. **Ends every sign-in waiting on its MFA code** (`staff_login_challenges.consumed_at`).
--   4. **Revokes the unused staff recovery codes** (`mfa_recovery_codes.revoked_at`). Used codes are left as the history they are.
--
-- It issues nothing: the invitation, its email and the audit event are written by the command in the same transaction.
-- Portal tables are not touched; nor is any other member's row.

BEGIN;

CREATE FUNCTION nzi_console.reset_staff_credential(p_organisation_id text, p_user_id text, p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = nzi_console, pg_temp AS $$
DECLARE retired integer; sessions_ended integer; challenges_ended integer; codes_revoked integer;
BEGIN
  IF p_organisation_id IS DISTINCT FROM current_setting('app.organisation_id', true) THEN RAISE EXCEPTION 'Tenant context mismatch'; END IF;
  UPDATE staff_credentials SET enabled = false, failed_attempts = 0, locked_until = NULL
   WHERE organisation_id = p_organisation_id AND user_id = p_user_id AND enabled;
  GET DIAGNOSTICS retired = ROW_COUNT;
  UPDATE staff_sessions SET revoked_at = p_at
   WHERE organisation_id = p_organisation_id AND user_id = p_user_id AND revoked_at IS NULL;
  GET DIAGNOSTICS sessions_ended = ROW_COUNT;
  UPDATE staff_login_challenges SET consumed_at = p_at
   WHERE organisation_id = p_organisation_id AND user_id = p_user_id AND consumed_at IS NULL;
  GET DIAGNOSTICS challenges_ended = ROW_COUNT;
  UPDATE mfa_recovery_codes SET revoked_at = p_at
   WHERE organisation_id = p_organisation_id AND principal = 'staff' AND subject_id = p_user_id AND used_at IS NULL AND revoked_at IS NULL;
  GET DIAGNOSTICS codes_revoked = ROW_COUNT;
  RETURN jsonb_build_object('credentialsRetired', retired, 'sessionsEnded', sessions_ended, 'challengesEnded', challenges_ended, 'recoveryCodesRevoked', codes_revoked);
END $$;
REVOKE ALL ON FUNCTION nzi_console.reset_staff_credential(text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nzi_console.reset_staff_credential(text, text, timestamptz) TO nzi_console_app;

COMMENT ON FUNCTION nzi_console.reset_staff_credential(text, text, timestamptz) IS
  'Admin sign-in reset for one staff member: disables the credential (kept), ends sessions and pending sign-ins, revokes unused recovery codes. Tenant-confined; returns counts.';

COMMIT;
