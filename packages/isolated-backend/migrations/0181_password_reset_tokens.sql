-- 0181 Password reset by email, for staff and portal sign-in (email programme phase 4-1, R3/R4).
--
-- ## Why
--
-- Neither the staff console nor the client portal had a way back from a forgotten password other than asking an
-- administrator. A reset by email needs a token that proves the request reached the account holder's own inbox.
--
-- ## What it adds
--
-- **`password_reset_tokens`** — one row per reset link, for either sign-in (`principal`), naming the account by its id
-- (`subject_id`: a staff `user_id` or a `portal_user_id`). Never an email address, a password or the token itself:
--
--   * **The token is stored only as its sha256** (`token_hash`), as login challenges (0006) and invitations (0023, 0129)
--     store theirs. The link carries the token; the database could not replay it.
--   * **Short-lived:** an hour at most, held by a CHECK as well as by the code.
--   * **Single-use:** `consumed_at` once it sets a password; `revoked_at` when a newer request supersedes it or a
--     completed reset clears the rest. Never both.
--   * **Never deleted** — a reset that happened is part of the account's security history, and the rate limit counts
--     recent rows.
--
-- Only the authentication role reaches it, as with every other pre-session table: the request and the completion both
-- run before anyone is signed in. The application and worker roles hold nothing on it.

BEGIN;

CREATE TABLE nzi_console.password_reset_tokens (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  reset_id text NOT NULL,
  principal text NOT NULL CHECK (principal IN ('staff','portal')),
  subject_id text NOT NULL CHECK (btrim(subject_id) <> ''),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (organisation_id, reset_id),
  CONSTRAINT password_reset_tokens_short_lived CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 hour'),
  CONSTRAINT password_reset_tokens_one_ending CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);

CREATE INDEX password_reset_tokens_subject_idx ON nzi_console.password_reset_tokens (organisation_id, principal, subject_id, created_at);

COMMENT ON TABLE nzi_console.password_reset_tokens IS
  'Password reset links for staff and portal sign-in: the token stored only as its sha256, an hour at most, single-use, never deleted. No address, password or token is held here.';

ALTER TABLE nzi_console.password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.password_reset_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.password_reset_tokens
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
-- The authentication context is not a tenant (it runs as 'authentication'), as for 0023's invitation lookup.
CREATE POLICY auth_password_reset ON nzi_console.password_reset_tokens TO nzi_console_auth USING (true) WITH CHECK (true);

REVOKE ALL ON nzi_console.password_reset_tokens FROM PUBLIC;
GRANT SELECT, INSERT ON nzi_console.password_reset_tokens TO nzi_console_auth;
GRANT UPDATE (consumed_at, revoked_at) ON nzi_console.password_reset_tokens TO nzi_console_auth;

-- The audit trail, as 0129 opened it for enrolment: the auth role may INSERT (never SELECT) audit events, confined here to
-- the three reset actions on a credential, so each lands atomically with the step it records. Same reasoning as 0129 for
-- not using a definer function. The events name the account's id only — never an address, password or token.
CREATE POLICY auth_password_reset_audit ON nzi_console.audit_events FOR INSERT TO nzi_console_auth WITH CHECK (
  action IN ('password.reset.requested', 'password.reset.throttled', 'password.reset.completed')
  AND entity_type IN ('staff_credential', 'portal_credential')
);

COMMIT;
