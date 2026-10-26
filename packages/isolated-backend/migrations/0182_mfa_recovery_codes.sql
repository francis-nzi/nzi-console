-- 0182 MFA recovery codes for staff and portal sign-in, and the portal invitation's code limit and audit trail (email
-- programme phase 4-2, R7).
--
-- ## Why
--
-- MFA is enrolled before anyone can sign in, so a lost authenticator had no way back but an administrator. Recovery codes
-- are that way back: a set of single-use codes, shown once at enrolment, each accepted once in place of an authenticator
-- code. (The phase-3 V7 review found V7 had them and the console did not.)
--
-- Grounding 4-2 also found the portal's accept step weaker than staff enrolment (0129) in two ways this closes: it had no
-- limit on wrong authenticator codes, and — because the authentication role could not write `audit_events` — it was
-- unaudited.
--
-- ## What it adds
--
-- **`mfa_recovery_codes`** — one row per code, for either sign-in (`principal`), naming the account by id only:
--
--   * **Stored only as its sha256** (`code_hash`), as every token here is. The code itself is shown once, to the person.
--   * **A batch** per generation. Generating again **revokes** the earlier batch's unused codes (`revoked_at`); using a code
--     sets `used_at`. Never both. Never deleted: what was used, and when, is part of the account's security history.
--   * Only the authentication role reaches it, as with every other credential table.
--
-- **`portal_invitations.failed_code_attempts`** — counted at the accept step; the fifth wrong code ends the invitation, as
-- 0129 does for staff.
--
-- **An audit policy for the authentication role**, as 0129 and 0181 opened it: INSERT only (never SELECT), confined to the
-- recovery-code actions and the portal accept step's own, so each lands atomically with the step it records. Ids only.

BEGIN;

CREATE TABLE nzi_console.mfa_recovery_codes (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  code_id text NOT NULL,
  principal text NOT NULL CHECK (principal IN ('staff','portal')),
  subject_id text NOT NULL CHECK (btrim(subject_id) <> ''),
  batch_id text NOT NULL,
  code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (organisation_id, code_id),
  CONSTRAINT mfa_recovery_codes_one_per_account UNIQUE (organisation_id, principal, subject_id, code_hash),
  CONSTRAINT mfa_recovery_codes_one_ending CHECK (used_at IS NULL OR revoked_at IS NULL)
);

CREATE INDEX mfa_recovery_codes_live_idx ON nzi_console.mfa_recovery_codes (organisation_id, principal, subject_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;

COMMENT ON TABLE nzi_console.mfa_recovery_codes IS
  'Single-use MFA recovery codes for staff and portal sign-in, each stored only as its sha256; a new batch revokes the old. Never deleted.';

ALTER TABLE nzi_console.mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.mfa_recovery_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.mfa_recovery_codes
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
CREATE POLICY auth_mfa_recovery ON nzi_console.mfa_recovery_codes TO nzi_console_auth USING (true) WITH CHECK (true);
REVOKE ALL ON nzi_console.mfa_recovery_codes FROM PUBLIC;
GRANT SELECT, INSERT ON nzi_console.mfa_recovery_codes TO nzi_console_auth;
GRANT UPDATE (used_at, revoked_at) ON nzi_console.mfa_recovery_codes TO nzi_console_auth;

ALTER TABLE nzi_console.portal_invitations
  ADD COLUMN failed_code_attempts integer NOT NULL DEFAULT 0 CHECK (failed_code_attempts >= 0);

CREATE POLICY auth_mfa_recovery_audit ON nzi_console.audit_events FOR INSERT TO nzi_console_auth WITH CHECK (
  (action IN ('mfa.recovery.generated', 'mfa.recovery.used') AND entity_type IN ('staff_credential', 'portal_credential'))
  OR (action IN ('portal.invitation.setup', 'portal.invitation.accepted', 'portal.invitation.code_rejected', 'portal.invitation.locked')
      AND entity_type = 'portal_invitation')
);

COMMIT;
