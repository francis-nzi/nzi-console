-- 0129 Staff self-enrolment: an operator issues a single-use invitation; the person sets their own password and
-- enrols their own authenticator; the credential is written only when they confirm a code (ruled 26 Sep 2026).
--
-- ## Why
--
-- The console becomes the capture home for net-zero-international, and real staff need credentials there. The only
-- way to make one today is `provisionStaffCredential`, which takes the person's password and TOTP secret from whoever
-- runs it — built for the fixed acceptance accounts, and wrong for a person: the operator would hold both factors.
-- This is the portal's invitation flow (0023) for staff, with three things the portal does not do: the credential
-- is written only on confirmation, the operator-facing role cannot read the pending secrets, and every step is audited.
--
-- ## What it adds
--
-- 1. `staff_enrolment_invitations` — one row per invitation. The token is never stored, only its SHA-256. It expires,
--    is single-use, and one open invitation per person: issuing another revokes the first. Between setup and
--    confirmation the row holds the person's password *hash* and their TOTP secret *encrypted*, and nothing else;
--    both are cleared when the invitation closes, by constraint.
--
-- 2. Who may touch it:
--    - `nzi_console_app` (the operator command) may create an invitation and revoke one, and read everything **except**
--      the token hash and the pending secrets — column grants, so the role that issues cannot read what the person set.
--    - `nzi_console_auth` (the enrolment routes) looks invitations up by token hash and advances them, as it does for
--      portal invitations.
--    - Nobody deletes.
--
-- 3. The membership the enrolment is for, readable by the auth role while an open invitation names it — the address
--    becomes the sign-in address. The same shape as 0023's invited-portal-user lookup.
--
-- 4. The audit trail. The auth role has never been able to write `audit_events`, which is why the portal's setup and
--    confirmation are unaudited. It gains INSERT — never SELECT — confined by policy to the four enrolment actions on
--    an invitation, so the events land atomically with the step they record. A definer function was the alternative;
--    it would have widened `nzi_console_definer`, which 0104 keeps to two functions on purpose.

BEGIN;

CREATE TABLE nzi_console.staff_enrolment_invitations (
  organisation_id text NOT NULL,
  invitation_id text NOT NULL,
  user_id text NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  pending_password_salt text,
  pending_password_hash text,
  pending_totp_ciphertext text,
  pending_totp_iv text,
  pending_totp_tag text,
  setup_started_at timestamptz,
  failed_code_attempts integer NOT NULL DEFAULT 0 CHECK (failed_code_attempts >= 0),
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, invitation_id),
  FOREIGN KEY (organisation_id, user_id) REFERENCES nzi_console.memberships (organisation_id, user_id),
  CHECK (expires_at > created_at),
  -- The pending secrets arrive together at setup, or not at all.
  CONSTRAINT staff_enrolment_pending_shape CHECK (
    (pending_password_salt IS NULL AND pending_password_hash IS NULL AND pending_totp_ciphertext IS NULL
      AND pending_totp_iv IS NULL AND pending_totp_tag IS NULL AND setup_started_at IS NULL)
    OR (pending_password_salt IS NOT NULL AND pending_password_hash IS NOT NULL AND pending_totp_ciphertext IS NOT NULL
      AND pending_totp_iv IS NOT NULL AND pending_totp_tag IS NOT NULL AND setup_started_at IS NOT NULL)
    OR ((consumed_at IS NOT NULL OR revoked_at IS NOT NULL) AND pending_password_hash IS NULL AND pending_totp_ciphertext IS NULL)
  ),
  -- A closed invitation keeps no secret: consumed moved it to the credential, revoked discarded it.
  CONSTRAINT staff_enrolment_closed_holds_nothing CHECK (
    (consumed_at IS NULL AND revoked_at IS NULL)
    OR (pending_password_salt IS NULL AND pending_password_hash IS NULL AND pending_totp_ciphertext IS NULL
      AND pending_totp_iv IS NULL AND pending_totp_tag IS NULL)
  ),
  CONSTRAINT staff_enrolment_closed_once CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);

CREATE UNIQUE INDEX staff_enrolment_one_open_per_person
  ON nzi_console.staff_enrolment_invitations (organisation_id, user_id) WHERE consumed_at IS NULL AND revoked_at IS NULL;

ALTER TABLE nzi_console.staff_enrolment_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.staff_enrolment_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.staff_enrolment_invitations
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
-- Looked up by token hash before any tenant is known, exactly as 0023's portal invitations are.
CREATE POLICY auth_enrolment_lookup ON nzi_console.staff_enrolment_invitations TO nzi_console_auth USING (true) WITH CHECK (true);

REVOKE ALL ON nzi_console.staff_enrolment_invitations FROM PUBLIC, nzi_console_app, nzi_console_auth, nzi_console_worker;
GRANT SELECT (organisation_id, invitation_id, user_id, expires_at, setup_started_at, failed_code_attempts, consumed_at,
              revoked_at, created_by, created_at)
  ON nzi_console.staff_enrolment_invitations TO nzi_console_app;
GRANT INSERT (organisation_id, invitation_id, user_id, token_hash, expires_at, created_by)
  ON nzi_console.staff_enrolment_invitations TO nzi_console_app;
-- Revoking clears the pending secrets in the same statement, so the app needs to write them to NULL — never to read them.
GRANT UPDATE (revoked_at, pending_password_salt, pending_password_hash, pending_totp_ciphertext, pending_totp_iv,
              pending_totp_tag)
  ON nzi_console.staff_enrolment_invitations TO nzi_console_app;
GRANT SELECT, UPDATE ON nzi_console.staff_enrolment_invitations TO nzi_console_auth;

CREATE POLICY auth_enrolment_membership_lookup ON nzi_console.memberships FOR SELECT TO nzi_console_auth USING (
  EXISTS (SELECT 1 FROM nzi_console.staff_enrolment_invitations i
           WHERE (i.organisation_id, i.user_id) = (memberships.organisation_id, memberships.user_id)
             AND i.consumed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now())
);

GRANT INSERT ON nzi_console.audit_events TO nzi_console_auth;
CREATE POLICY auth_enrolment_audit ON nzi_console.audit_events FOR INSERT TO nzi_console_auth WITH CHECK (
  action IN ('staff.enrolment.setup', 'staff.enrolment.complete', 'staff.enrolment.code_rejected', 'staff.enrolment.locked')
  AND entity_type = 'staff_enrolment_invitation'
);

COMMENT ON TABLE nzi_console.staff_enrolment_invitations IS
  'Operator-issued, single-use, expiring staff enrolment invitations (0129). The token is stored only as its SHA-256; the password hash and encrypted TOTP secret are held only between setup and confirmation, and the operator-facing role cannot read them.';

COMMIT;
