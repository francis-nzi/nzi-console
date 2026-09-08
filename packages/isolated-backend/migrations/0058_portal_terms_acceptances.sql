BEGIN;

-- Client portal Phase 2, precondition P2b — terms-of-access gate. Live gates
-- every portal shell load on `must_accept_tac`; the rebuild had no terms
-- handling. An append-only acceptance record ("who accepted which version,
-- when") — one row per (user, terms version), so re-issuing the version
-- re-gates every existing user until they accept the new one.
--
-- Written to be safely re-appliable (the isolated-staging apply was retried
-- through a flaky pooler).
CREATE TABLE IF NOT EXISTS nzi_console.portal_terms_acceptances (
  organisation_id text NOT NULL,
  portal_user_id text NOT NULL,
  terms_version text NOT NULL CHECK (terms_version = trim(terms_version) AND terms_version <> ''),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id,portal_user_id,terms_version),
  FOREIGN KEY (organisation_id,portal_user_id) REFERENCES nzi_console.portal_users(organisation_id,portal_user_id)
);

ALTER TABLE nzi_console.portal_terms_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.portal_terms_acceptances FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nzi_console.portal_terms_acceptances;
CREATE POLICY tenant_isolation ON nzi_console.portal_terms_acceptances USING (organisation_id=current_setting('app.organisation_id',true)) WITH CHECK (organisation_id=current_setting('app.organisation_id',true));
-- The gate check and the acceptance write both run under the auth role at
-- request time (`resolvePortalPrincipal` / `acceptPortalTerms`).
DROP POLICY IF EXISTS auth_terms_acceptance ON nzi_console.portal_terms_acceptances;
CREATE POLICY auth_terms_acceptance ON nzi_console.portal_terms_acceptances TO nzi_console_auth USING (true) WITH CHECK (true);

GRANT SELECT ON nzi_console.portal_terms_acceptances TO nzi_console_app;
GRANT SELECT,INSERT ON nzi_console.portal_terms_acceptances TO nzi_console_auth;
-- Append-only: an acceptance is a permanent record.
REVOKE UPDATE,DELETE ON nzi_console.portal_terms_acceptances FROM PUBLIC,nzi_console_app,nzi_console_auth,nzi_console_worker;

COMMIT;
