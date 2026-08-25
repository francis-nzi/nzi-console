BEGIN;

SET search_path TO nzi_console, public;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nzi_console_auth') THEN
    CREATE ROLE nzi_console_auth NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOLOGIN;
  END IF;
END $$;

GRANT nzi_console_auth TO CURRENT_USER;
GRANT USAGE ON SCHEMA nzi_console TO nzi_console_auth;

CREATE TABLE staff_credentials (
  organisation_id text NOT NULL,
  user_id text NOT NULL,
  email_normalized text NOT NULL,
  password_salt text NOT NULL,
  password_hash text NOT NULL,
  totp_ciphertext text NOT NULL,
  totp_iv text NOT NULL,
  totp_tag text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  last_login_at timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, user_id),
  UNIQUE (organisation_id, email_normalized),
  FOREIGN KEY (organisation_id, user_id) REFERENCES memberships(organisation_id, user_id),
  CHECK (email_normalized = lower(trim(email_normalized)))
);

CREATE TABLE staff_login_challenges (
  organisation_id text NOT NULL,
  challenge_id text NOT NULL,
  user_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, challenge_id),
  FOREIGN KEY (organisation_id, user_id) REFERENCES staff_credentials(organisation_id, user_id)
);

CREATE TABLE staff_sessions (
  organisation_id text NOT NULL,
  session_id text NOT NULL,
  user_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, session_id),
  FOREIGN KEY (organisation_id, user_id) REFERENCES staff_credentials(organisation_id, user_id)
);

CREATE INDEX staff_challenges_expiry_idx ON staff_login_challenges(expires_at) WHERE consumed_at IS NULL;
CREATE INDEX staff_sessions_expiry_idx ON staff_sessions(expires_at) WHERE revoked_at IS NULL;

REVOKE ALL ON staff_credentials, staff_login_challenges, staff_sessions FROM PUBLIC, nzi_console_app, nzi_console_worker;
GRANT SELECT, INSERT, UPDATE ON staff_credentials, staff_login_challenges, staff_sessions TO nzi_console_auth;
GRANT SELECT ON memberships TO nzi_console_auth;

COMMIT;
