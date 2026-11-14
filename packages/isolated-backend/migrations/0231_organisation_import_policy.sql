-- 0231 The organisation's import policy: whether committing an import refresh needs an Admin
-- (BRIEF-v7-import-server-side-phase-b, R-6: "an Admin gate on commit is optional — config, off by default").
--
-- `import.refresh` (matrix v15, 0230) is CRM-operable: a Consultant may preview a job's refresh from the previous system and
-- commit it. An organisation that wants a second pair of eyes on the commit sets this, and then only an Admin commits; the
-- preview stays the CRM's.
--
--   * One row per organisation, written only when someone sets the policy. **No row means off** — the ruled default: a CRM
--     commits. 0215's pattern otherwise, exactly.
--   * Versioned (`expectedVersion`; 1 on the first write), with who and when. The audit event, written by the command in the
--     same transaction, carries the old and new value and the reason.
--   * Written by `organisation.importPolicy.set`, gated by `admin.settings` (Admin). The application role holds SELECT, INSERT
--     and UPDATE; nobody holds DELETE, so a policy is changed, never silently dropped back to default.
--   * Fail-closed on read: the refresh commit reads it inside its own transaction; a read that fails fails the command.
--
-- Forced row-level security with the tenant policy. No money, no PII.

BEGIN;

CREATE TABLE nzi_console.organisation_import_policy (
  organisation_id text PRIMARY KEY REFERENCES nzi_console.organisations(organisation_id),
  refresh_commit_requires_admin boolean NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE nzi_console.organisation_import_policy IS
  'The organisation''s import policy (0231). No row = a CRM holding import.refresh commits a refresh; true = only an Admin commits. The preview is unaffected.';

ALTER TABLE nzi_console.organisation_import_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.organisation_import_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.organisation_import_policy
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

REVOKE ALL ON nzi_console.organisation_import_policy FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON nzi_console.organisation_import_policy TO nzi_console_app;

COMMIT;
