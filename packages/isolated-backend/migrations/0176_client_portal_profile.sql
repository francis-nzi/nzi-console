-- 0176 What a client's portal offers them, and the record of who decided that (portal data-entry phase 1;
-- RULING-portal-dataentry-01, decisions 2 and 3; BUILD-portal-dataentry-phase1 §2–§3).
--
-- Two registers, both shaped exactly as `client_category_visibility` (0096, NZC-110) is: a row is written only
-- where somebody decided something, its absence means the default, and withdrawing a decision deactivates the row
-- rather than removing it, so the record of having decided survives the decision.
--
-- ## client_portal_profile_decisions — the portal's fixed toggles, per client, over the org default
--
-- The default profile is code (`portalProfile.ts`, `PORTAL_PROFILE_DEFAULT`): Setup, Time and dataset editing
-- hidden; milestones view-only; the simple first-entry drawer; the detailed row drawer's four sections hidden; the
-- deactivate action disabled. History is not here — it is always visible to the client and is not a setting.
-- A row is a client's deviation from that default, or the default restated deliberately; either way a decision.
--
-- One row per decision, typed by key, rather than a settings blob: the register stays auditable (who changed which
-- toggle, when, from what) and the staff preview can explain any single difference. The allowed values for each
-- key are enforced here as well as in the command, so no path — the command, an import, a hand-written statement —
-- can store a value the portal does not understand. In particular **milestones is never `edit`** (decision 3):
-- view-only is enforced at the write boundary, not only by what the UI offers.
--
-- ## client_portal_scope_visibility — a scope switched off for one client
--
-- Category on/off already exists (0096). This is the scope above it: default visible, a row only where somebody
-- decided. The two compose by AND — a category is shown only when its scope is not hidden *and* the category itself
-- is not hidden — so a hidden scope hides every category in it without a row per category, and switching the scope
-- back on restores exactly the category decisions that were there before.
--
-- ## Not yet in force on the live portal
--
-- Phase 1 records and explains these decisions; the live portal surfaces begin to follow them in phase 2, with the
-- capture loop. Category visibility (0096) already applies, as before. Nothing here touches the portal data-entry
-- records path, which stays live and unchanged.

BEGIN;

CREATE TABLE nzi_console.client_portal_profile_decisions (
  organisation_id text NOT NULL,
  client_id text NOT NULL,
  profile_key text NOT NULL,
  value text NOT NULL,
  -- Why, in the consultant's words. Optional, as on 0096.
  note text NOT NULL DEFAULT '',
  -- Superseded rather than removed: a decision that was in force stays in the record.
  active boolean NOT NULL DEFAULT true,
  decided_by text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, client_id, profile_key),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id) ON DELETE CASCADE,
  -- Each key's own value set (portalProfile.ts mirrors it; a test pins the two together).
  CONSTRAINT client_portal_profile_decisions_value CHECK (
    (profile_key IN ('setup', 'time', 'datasets', 'evidenceProvenance', 'factorCalculation', 'dataQuality', 'sourceDetail')
      AND value IN ('visible', 'hidden'))
    OR (profile_key = 'milestones' AND value IN ('view', 'hidden'))
    OR (profile_key = 'entryDrawer' AND value IN ('simple', 'detailed'))
    OR (profile_key = 'deactivate' AND value IN ('enabled', 'disabled')))
);

COMMENT ON TABLE nzi_console.client_portal_profile_decisions IS
  'Per-client decisions on what the client portal offers (areas, the entry drawer, the detailed row drawer''s sections, the deactivate action), over the code-defined default. A row exists only where somebody decided; withdrawing deactivates it. History is not a setting and is not here.';
COMMENT ON COLUMN nzi_console.client_portal_profile_decisions.value IS
  'The decision, from the key''s own value set. Milestones is view or hidden, never edit: a portal principal never edits a milestone.';
COMMENT ON COLUMN nzi_console.client_portal_profile_decisions.active IS
  'Deactivated rather than deleted when a decision is withdrawn, so the record of having decided survives the decision.';

CREATE INDEX client_portal_profile_decisions_client_idx
  ON nzi_console.client_portal_profile_decisions(organisation_id, client_id) WHERE active;

CREATE TABLE nzi_console.client_portal_scope_visibility (
  organisation_id text NOT NULL,
  client_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('1', '2', '3')),
  visible boolean NOT NULL,
  note text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  decided_by text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, client_id, scope),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id) ON DELETE CASCADE
);

COMMENT ON TABLE nzi_console.client_portal_scope_visibility IS
  'Per-client, per-scope disclosure decisions. Default visible; a row exists only where somebody decided. Composes with client_category_visibility by AND: a category is shown only when its scope is not hidden and it is not hidden itself.';
COMMENT ON COLUMN nzi_console.client_portal_scope_visibility.visible IS
  'The decision. false hides the scope, and so every category in it, from this client; true records a decision to show it, the default restated deliberately.';
COMMENT ON COLUMN nzi_console.client_portal_scope_visibility.active IS
  'Deactivated rather than deleted when a decision is withdrawn, so the record of having decided survives the decision.';

CREATE INDEX client_portal_scope_visibility_client_idx
  ON nzi_console.client_portal_scope_visibility(organisation_id, client_id) WHERE active;

ALTER TABLE nzi_console.client_portal_profile_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_portal_profile_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_portal_profile_decisions
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

ALTER TABLE nzi_console.client_portal_scope_visibility ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_portal_scope_visibility FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_portal_scope_visibility
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

GRANT SELECT, INSERT, UPDATE ON nzi_console.client_portal_profile_decisions, nzi_console.client_portal_scope_visibility TO nzi_console_app;
REVOKE DELETE ON nzi_console.client_portal_profile_decisions, nzi_console.client_portal_scope_visibility
  FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

COMMIT;
