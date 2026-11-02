-- Client-level portal access (RULING-portal-access-model; Portal Management → Access): the master switch, expiry and the
-- V7-parity record around them, with an append-only decision log, and an append-only record of every sign-in attempt.
--
--   client_portal_access            one row per client; ABSENT = the defaults (enabled, not trained, no expiry, no cap, payment "—").
--                                   So deploying this changes nothing for any client until somebody decides something.
--   client_portal_access_decisions  who changed which field, from what to what, when, and why — never updated, never deleted.
--   portal_login_events             every attempt (outcome + time + user, or a hash of the address for an unknown one), written
--                                   by the auth role only; IP and user-agent are personal data and are nulled after 90 days.
--
-- Enforcement (login, MFA completion, the per-request session check) reads ONLY `enabled` and `expires_at`: the auth role is
-- granted those two columns and the key, never `notes`, the payment fields or the cap. A switched-off or expired client is refused
-- exactly as an unknown user is, and a switch-off ends the client's live sessions through a confined definer function, as 0024 does
-- for one user. The user cap is informational: nothing reads it to refuse an invitation.

CREATE TABLE nzi_console.client_portal_access (
  organisation_id text NOT NULL,
  client_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  trained boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  user_cap integer CHECK (user_cap IS NULL OR user_cap >= 0),
  payment_status text CHECK (payment_status IS NULL OR payment_status IN ('unpaid', 'paid', 'waived')),
  payment_ref text CHECK (payment_ref IS NULL OR char_length(payment_ref) <= 120),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 4000),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, client_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id) ON DELETE CASCADE
);

CREATE TABLE nzi_console.client_portal_access_decisions (
  organisation_id text NOT NULL,
  decision_id text NOT NULL,
  client_id text NOT NULL,
  field text NOT NULL CHECK (field IN ('enabled', 'trained', 'expires_at', 'user_cap', 'payment_status', 'payment_ref', 'notes')),
  from_json jsonb,
  to_json jsonb,
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  changed_by text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, decision_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id) ON DELETE CASCADE
);
CREATE INDEX client_portal_access_decisions_idx ON nzi_console.client_portal_access_decisions(organisation_id, client_id, changed_at DESC);

CREATE TABLE nzi_console.portal_login_events (
  organisation_id text NOT NULL,
  event_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL CHECK (outcome IN ('success', 'bad_password', 'locked', 'unknown_user', 'user_disabled', 'client_disabled', 'client_expired', 'bad_code', 'invalid_challenge')),
  portal_user_id text,
  client_id text,
  -- For an address that matches no user: a SHA-256 of the lower-cased address, never the address itself.
  email_hash text CHECK (email_hash IS NULL OR email_hash ~ '^[0-9a-f]{64}$'),
  ip text CHECK (ip IS NULL OR char_length(ip) <= 64),
  user_agent text CHECK (user_agent IS NULL OR char_length(user_agent) <= 300),
  PRIMARY KEY (organisation_id, event_id)
);
CREATE INDEX portal_login_events_client_idx ON nzi_console.portal_login_events(organisation_id, client_id, occurred_at DESC) WHERE client_id IS NOT NULL;
CREATE INDEX portal_login_events_user_idx ON nzi_console.portal_login_events(organisation_id, portal_user_id, occurred_at DESC) WHERE portal_user_id IS NOT NULL;
CREATE INDEX portal_login_events_network_idx ON nzi_console.portal_login_events(organisation_id, occurred_at) WHERE ip IS NOT NULL OR user_agent IS NOT NULL;

ALTER TABLE nzi_console.client_portal_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_portal_access FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_portal_access USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
ALTER TABLE nzi_console.client_portal_access_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_portal_access_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_portal_access_decisions USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
ALTER TABLE nzi_console.portal_login_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.portal_login_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.portal_login_events USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

-- The auth role runs in an "authentication" tenant context (withAuthTransaction), not an organisation's, so the tenant policies above do
-- not admit it — the same shape as 0018's auth_portal_user_lookup. Without these two, the login would see no access record at all and
-- fail OPEN (every client enabled), which is exactly what the enforcement tests are there to catch. Its reach is the column grants below:
-- the gate columns on the record, and INSERT on the events.
CREATE POLICY auth_gate_read ON nzi_console.client_portal_access FOR SELECT TO nzi_console_auth USING (true);
CREATE POLICY auth_event_write ON nzi_console.portal_login_events FOR INSERT TO nzi_console_auth WITH CHECK (true);

-- The application role runs the staff command and reads. The decision log and the events are append-only: no UPDATE, no DELETE.
GRANT SELECT, INSERT, UPDATE ON nzi_console.client_portal_access TO nzi_console_app;
GRANT SELECT, INSERT ON nzi_console.client_portal_access_decisions TO nzi_console_app;
GRANT SELECT ON nzi_console.portal_login_events TO nzi_console_app;
-- The auth role reads the gate and nothing else about a client's access, and writes the events.
GRANT SELECT (organisation_id, client_id, enabled, expires_at) ON nzi_console.client_portal_access TO nzi_console_auth;
GRANT INSERT ON nzi_console.portal_login_events TO nzi_console_auth;

-- Ending a client's live sessions: a confined definer function (0024's shape for one user, for a client). Tenant-confined, one
-- direction (sets revoked_at, nothing else), executable by the application role only.
CREATE FUNCTION nzi_console.revoke_client_portal_sessions(p_organisation_id text, p_client_id text, p_revoked_at timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = nzi_console, pg_temp AS $$
DECLARE affected integer;
BEGIN
  IF p_organisation_id IS DISTINCT FROM current_setting('app.organisation_id', true) THEN RAISE EXCEPTION 'Tenant context mismatch'; END IF;
  UPDATE portal_sessions SET revoked_at = coalesce(revoked_at, p_revoked_at)
   WHERE organisation_id = p_organisation_id AND client_id = p_client_id AND revoked_at IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION nzi_console.revoke_client_portal_sessions(text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nzi_console.revoke_client_portal_sessions(text, text, timestamptz) TO nzi_console_app;

-- Retention: IP and user-agent are kept 90 days. The outcome, time and user stay for the normal audit horizon; only the network
-- data is nulled. The table is otherwise append-only, so this definer function is the one thing that may change a row.
CREATE FUNCTION nzi_console.purge_portal_login_event_network_data(p_organisation_id text, p_cutoff timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = nzi_console, pg_temp AS $$
DECLARE affected integer;
BEGIN
  IF p_organisation_id IS DISTINCT FROM current_setting('app.organisation_id', true) THEN RAISE EXCEPTION 'Tenant context mismatch'; END IF;
  UPDATE portal_login_events SET ip = NULL, user_agent = NULL
   WHERE organisation_id = p_organisation_id AND occurred_at < p_cutoff AND (ip IS NOT NULL OR user_agent IS NOT NULL);
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION nzi_console.purge_portal_login_event_network_data(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nzi_console.purge_portal_login_event_network_data(text, timestamptz) TO nzi_console_app, nzi_console_worker;

COMMENT ON TABLE nzi_console.client_portal_access IS 'One row per client; absent = defaults. enabled + expires_at are enforced at portal login, MFA completion and every session check; the rest is informational. The auth role is granted enabled and expires_at only.';
COMMENT ON TABLE nzi_console.portal_login_events IS 'Every portal sign-in attempt. Append-only; written by the auth role. ip and user_agent are nulled after 90 days (purge_portal_login_event_network_data).';
