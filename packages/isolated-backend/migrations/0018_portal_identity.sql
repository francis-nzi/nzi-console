BEGIN;

CREATE TABLE nzi_console.portal_users (
  organisation_id text NOT NULL,
  portal_user_id text NOT NULL,
  client_id text NOT NULL,
  email_normalized text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id,portal_user_id),
  UNIQUE (organisation_id,email_normalized),
  UNIQUE (organisation_id,portal_user_id,client_id),
  FOREIGN KEY (organisation_id,client_id) REFERENCES nzi_console.clients(organisation_id,client_id),
  CHECK (email_normalized=lower(trim(email_normalized)))
);

CREATE TABLE nzi_console.portal_credentials (
  organisation_id text NOT NULL,
  portal_user_id text NOT NULL,
  password_salt text NOT NULL,
  password_hash text NOT NULL,
  totp_ciphertext text NOT NULL,
  totp_iv text NOT NULL,
  totp_tag text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts>=0),
  locked_until timestamptz,
  last_login_at timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id,portal_user_id),
  FOREIGN KEY (organisation_id,portal_user_id) REFERENCES nzi_console.portal_users(organisation_id,portal_user_id)
);

CREATE TABLE nzi_console.portal_login_challenges (
  organisation_id text NOT NULL,
  challenge_id text NOT NULL,
  portal_user_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id,challenge_id),
  FOREIGN KEY (organisation_id,portal_user_id) REFERENCES nzi_console.portal_credentials(organisation_id,portal_user_id)
);

CREATE TABLE nzi_console.portal_sessions (
  organisation_id text NOT NULL,
  session_id text NOT NULL,
  portal_user_id text NOT NULL,
  client_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id,session_id),
  FOREIGN KEY (organisation_id,portal_user_id,client_id) REFERENCES nzi_console.portal_users(organisation_id,portal_user_id,client_id)
);

ALTER TABLE nzi_console.portal_access_grants ADD CONSTRAINT portal_access_grant_user_client_fk
  FOREIGN KEY (organisation_id,portal_user_id,client_id)
  REFERENCES nzi_console.portal_users(organisation_id,portal_user_id,client_id);

CREATE INDEX portal_challenges_expiry_idx ON nzi_console.portal_login_challenges(expires_at) WHERE consumed_at IS NULL;
CREATE INDEX portal_sessions_expiry_idx ON nzi_console.portal_sessions(expires_at) WHERE revoked_at IS NULL;
CREATE INDEX portal_grants_user_job_idx ON nzi_console.portal_access_grants(organisation_id,portal_user_id,job_id) WHERE revoked_at IS NULL;

ALTER TABLE nzi_console.portal_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.portal_users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.portal_users USING (organisation_id=current_setting('app.organisation_id',true)) WITH CHECK (organisation_id=current_setting('app.organisation_id',true));
CREATE POLICY auth_portal_user_lookup ON nzi_console.portal_users FOR SELECT TO nzi_console_auth USING (EXISTS (SELECT 1 FROM nzi_console.portal_credentials c WHERE (c.organisation_id,c.portal_user_id)=(portal_users.organisation_id,portal_users.portal_user_id) AND c.enabled=true));

GRANT SELECT,INSERT,UPDATE ON nzi_console.portal_users TO nzi_console_app;
REVOKE ALL ON nzi_console.portal_credentials,nzi_console.portal_login_challenges,nzi_console.portal_sessions FROM PUBLIC,nzi_console_app,nzi_console_worker;
GRANT SELECT,INSERT,UPDATE ON nzi_console.portal_credentials,nzi_console.portal_login_challenges,nzi_console.portal_sessions TO nzi_console_auth;
GRANT SELECT ON nzi_console.portal_users TO nzi_console_auth;

COMMIT;
