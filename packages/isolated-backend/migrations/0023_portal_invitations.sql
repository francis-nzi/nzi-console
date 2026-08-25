BEGIN;

CREATE TABLE nzi_console.portal_invitations (
  organisation_id text NOT NULL,
  invitation_id text NOT NULL,
  portal_user_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  setup_started_at timestamptz,
  consumed_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id,invitation_id),
  FOREIGN KEY (organisation_id,portal_user_id) REFERENCES nzi_console.portal_users(organisation_id,portal_user_id)
);

CREATE INDEX portal_invitations_expiry_idx ON nzi_console.portal_invitations(expires_at) WHERE consumed_at IS NULL;
ALTER TABLE nzi_console.portal_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.portal_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.portal_invitations USING (organisation_id=current_setting('app.organisation_id',true)) WITH CHECK (organisation_id=current_setting('app.organisation_id',true));
CREATE POLICY auth_invitation_lookup ON nzi_console.portal_invitations TO nzi_console_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_invited_portal_user_lookup ON nzi_console.portal_users FOR SELECT TO nzi_console_auth USING (
  EXISTS (SELECT 1 FROM nzi_console.portal_invitations i WHERE (i.organisation_id,i.portal_user_id)=(portal_users.organisation_id,portal_users.portal_user_id) AND i.consumed_at IS NULL AND i.expires_at>now())
);
CREATE POLICY auth_portal_user_activation ON nzi_console.portal_users FOR UPDATE TO nzi_console_auth USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE ON nzi_console.portal_invitations TO nzi_console_app;
GRANT SELECT,UPDATE ON nzi_console.portal_invitations TO nzi_console_auth;
GRANT UPDATE ON nzi_console.portal_users TO nzi_console_auth;
REVOKE DELETE ON nzi_console.portal_invitations FROM PUBLIC,nzi_console_app,nzi_console_auth,nzi_console_worker;

COMMIT;
