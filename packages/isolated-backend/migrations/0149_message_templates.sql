-- 0149 Message templates (admin Phase F1; ruled plan `phaseF-comms-crm-plan.md`, F-Q2/F-Q3/F-Q7): an organisation's own
-- wording for the messages the console sends.
--
-- ## What it adds
--
-- **`message_templates`** — one row per organisation per key: a subject and a plain-text body, active or not, versioned.
--
-- - **The key is set once.** It is the identity a send-site looks the wording up by; the set of keys is governed in code
--   (`MESSAGE_TEMPLATE_REGISTRY`, F-Q3), so the command refuses a key no send-site uses. The role holds no UPDATE on it.
-- - **No row, or an inactive one, means the built-in wording** — the registry's, which is word for word what the
--   send-sites composed before F1. Deactivating a template is how an organisation goes back to it; nothing is deleted.
-- - **Email only** (`channel`), plain text as the mailer sends it. Who it is from and the footer come from the
--   organisation profile, not from here (F-Q7); the transport itself is out of scope.
-- - **The worker reads it.** `nzi_console_worker` composes the strategy reminders, so it is granted SELECT here; it writes
--   nothing.
--
-- Forced row-level security and the tenant policy; no DELETE for anyone (R3); 0132's import provenance.

BEGIN;

CREATE TABLE nzi_console.message_templates (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  template_key text NOT NULL CHECK (template_key ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$' AND length(template_key) <= 80),
  channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  subject text NOT NULL CHECK (btrim(subject) <> '' AND length(subject) <= 200),
  body text NOT NULL CHECK (btrim(body) <> '' AND length(body) <= 10000),
  active boolean NOT NULL DEFAULT true,
  source_system text,
  legacy_db_id text,
  legacy_values jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),
  PRIMARY KEY (organisation_id, template_key),
  CONSTRAINT message_templates_import_provenance_shape CHECK (
    (source_system IS NULL AND legacy_db_id IS NULL AND legacy_values IS NULL)
    OR (source_system IS NOT NULL AND btrim(source_system) <> '' AND legacy_db_id IS NOT NULL AND btrim(legacy_db_id) <> ''
        AND legacy_values IS NOT NULL))
);
CREATE UNIQUE INDEX message_templates_import_identity_key ON nzi_console.message_templates (organisation_id, source_system, legacy_db_id)
  WHERE source_system IS NOT NULL;
COMMENT ON TABLE nzi_console.message_templates IS
  'An organisation''s wording for a message the console sends (admin F1): the key set once and governed in code (F-Q3); no row, or an inactive one, means the built-in wording. Never deleted.';

ALTER TABLE nzi_console.message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.message_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.message_templates
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
REVOKE ALL ON nzi_console.message_templates FROM PUBLIC;
-- The key and channel are inserted once and never updated.
GRANT SELECT, INSERT ON nzi_console.message_templates TO nzi_console_app;
GRANT UPDATE (subject, body, active, source_system, legacy_db_id, legacy_values, version, updated_at, updated_by)
  ON nzi_console.message_templates TO nzi_console_app;
-- The reminder worker reads the wording it sends; nothing more.
GRANT SELECT ON nzi_console.message_templates TO nzi_console_worker;

COMMIT;
