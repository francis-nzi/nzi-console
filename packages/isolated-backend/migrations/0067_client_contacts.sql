BEGIN;

-- Client contacts with roles. A contact carries a primary flag (one per client) and
-- any of four roles, each feeding one downstream picker:
--   report_signee      → the signee options on report validation / the published report
--   portal_candidate   → who can be invited to the client portal
--   invoice_recipient  → who receives quotes and invoices
--   training_attendee  → who is eligible for training places
-- Versioned (every change appends a history row) and deactivated, never deleted.

CREATE TABLE nzi_console.client_contacts (
  organisation_id text NOT NULL,
  contact_id text NOT NULL,
  client_id text NOT NULL,
  full_name text NOT NULL CHECK (full_name = trim(full_name) AND full_name <> ''),
  job_title text,
  email text,
  phone text,
  is_primary boolean NOT NULL DEFAULT false,
  roles text[] NOT NULL DEFAULT '{}'
    CHECK (roles <@ ARRAY['report_signee','portal_candidate','invoice_recipient','training_attendee']::text[]),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deactivated_by text,
  deactivated_at timestamptz,
  PRIMARY KEY (organisation_id, contact_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id),
  CHECK ((status = 'inactive') = (deactivated_at IS NOT NULL)),
  CHECK (NOT (is_primary AND status = 'inactive'))
);
CREATE INDEX client_contacts_client_idx ON nzi_console.client_contacts (organisation_id, client_id);
CREATE UNIQUE INDEX client_contacts_one_primary ON nzi_console.client_contacts (organisation_id, client_id)
  WHERE is_primary AND status = 'active';

CREATE TABLE nzi_console.client_contact_versions (
  organisation_id text NOT NULL,
  contact_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  snapshot_json jsonb NOT NULL,
  changed_by text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text NOT NULL,
  PRIMARY KEY (organisation_id, contact_id, version),
  FOREIGN KEY (organisation_id, contact_id) REFERENCES nzi_console.client_contacts(organisation_id, contact_id)
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['client_contacts','client_contact_versions'] LOOP
    EXECUTE format('ALTER TABLE nzi_console.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE nzi_console.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON nzi_console.%I USING (organisation_id = current_setting(''app.organisation_id'', true)) WITH CHECK (organisation_id = current_setting(''app.organisation_id'', true))', table_name);
    EXECUTE format('REVOKE DELETE ON nzi_console.%I FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth', table_name);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON nzi_console.client_contacts TO nzi_console_app;
GRANT SELECT, INSERT ON nzi_console.client_contact_versions TO nzi_console_app;
REVOKE UPDATE ON nzi_console.client_contact_versions FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

-- Carry each client's existing single contact across as its primary contact (no roles
-- assumed — a signee or recipient is a deliberate choice). The legacy columns stay
-- for history; the contacts list is now the source.
INSERT INTO nzi_console.client_contacts
  (organisation_id, contact_id, client_id, full_name, job_title, email, is_primary, roles, created_by, updated_by)
SELECT c.organisation_id, gen_random_uuid()::text, c.client_id, trim(c.contact_name),
       nullif(trim(c.contact_role), ''), nullif(trim(c.contact_email), ''), true, '{}', 'migration:0067', 'migration:0067'
FROM nzi_console.clients c
WHERE nullif(trim(c.contact_name), '') IS NOT NULL;
INSERT INTO nzi_console.client_contact_versions (organisation_id, contact_id, version, snapshot_json, changed_by, correlation_id)
SELECT organisation_id, contact_id, 1,
       jsonb_build_object('fullName', full_name, 'jobTitle', job_title, 'email', email, 'phone', phone, 'isPrimary', is_primary, 'roles', to_jsonb(roles), 'status', status),
       'migration:0067', 'migration:0067'
FROM nzi_console.client_contacts;

-- The signee on a report version: the contact chosen at validation, with the name and
-- title frozen so a published report reproduces exactly even if the contact changes.
ALTER TABLE nzi_console.report_versions
  ADD COLUMN signee_contact_id text,
  ADD COLUMN signee_name text,
  ADD COLUMN signee_job_title text,
  ADD CONSTRAINT report_versions_signee_pair CHECK ((signee_contact_id IS NULL) = (signee_name IS NULL));

COMMIT;
