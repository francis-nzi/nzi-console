BEGIN;

-- NZC-022 — the permission matrix (docs/PERMISSION_MATRIX.md) as migration-owned,
-- versioned config. Staff principals resolve their capabilities from the current
-- matrix version at sign-in; nothing is created or altered at request time.
--
-- The rows below are held equal to ROLE_CAPABILITY_MATRIX in @nzi/contracts by a
-- test, so the code copy the UI reads and the rows the server enforces cannot drift.
-- A change to the matrix is a new version (a new migration), never an edit here.

CREATE TABLE nzi_console.staff_capability_matrix_versions (
  matrix_version integer PRIMARY KEY CHECK (matrix_version > 0),
  source text NOT NULL,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE nzi_console.staff_role_capabilities (
  matrix_version integer NOT NULL REFERENCES nzi_console.staff_capability_matrix_versions(matrix_version),
  role_id text NOT NULL CHECK (role_id IN ('admin','consultant','reviewer','finance','viewer')),
  capability text NOT NULL CHECK (capability ~ '^[a-z]+\.[a-z_]+$'),
  scope text NOT NULL CHECK (scope IN ('all','own_clients')),
  PRIMARY KEY (matrix_version, role_id, capability)
);

INSERT INTO nzi_console.staff_capability_matrix_versions (matrix_version, source, note)
VALUES (1, 'docs/PERMISSION_MATRIX.md', 'Initial matrix: Admin, Consultant, Reviewer, Finance, Viewer (NZC-022).');

INSERT INTO nzi_console.staff_role_capabilities (matrix_version, role_id, capability, scope) VALUES
  (1, 'admin', 'client.view', 'all'),
  (1, 'admin', 'client.create', 'all'),
  (1, 'admin', 'client.edit', 'all'),
  (1, 'admin', 'client.deactivate', 'all'),
  (1, 'admin', 'contact.manage', 'all'),
  (1, 'admin', 'site.manage', 'all'),
  (1, 'admin', 'target.edit', 'all'),
  (1, 'admin', 'baseline.rebaseline', 'all'),
  (1, 'admin', 'job.manage', 'all'),
  (1, 'admin', 'scoperow.edit', 'all'),
  (1, 'admin', 'snapshot.review', 'all'),
  (1, 'admin', 'report.edit', 'all'),
  (1, 'admin', 'report.publish', 'all'),
  (1, 'admin', 'report.view', 'all'),
  (1, 'admin', 'actions.manage', 'all'),
  (1, 'admin', 'srs.manage', 'all'),
  (1, 'admin', 'finance.view', 'all'),
  (1, 'admin', 'finance.manage', 'all'),
  (1, 'admin', 'portal.admin', 'all'),
  (1, 'admin', 'clientfactor.manage', 'all'),
  (1, 'admin', 'dataset.manage', 'all'),
  (1, 'admin', 'factor.manage', 'all'),
  (1, 'admin', 'admin.users', 'all'),
  (1, 'admin', 'admin.lookups', 'all'),
  (1, 'admin', 'admin.templates', 'all'),
  (1, 'admin', 'admin.settings', 'all'),
  (1, 'admin', 'audit.view', 'all'),
  (1, 'admin', 'support.portal_impersonate', 'all'),
  (1, 'consultant', 'client.view', 'all'),
  (1, 'consultant', 'client.create', 'all'),
  (1, 'consultant', 'client.edit', 'all'),
  (1, 'consultant', 'contact.manage', 'all'),
  (1, 'consultant', 'site.manage', 'all'),
  (1, 'consultant', 'target.edit', 'all'),
  (1, 'consultant', 'baseline.rebaseline', 'own_clients'),
  (1, 'consultant', 'job.manage', 'all'),
  (1, 'consultant', 'scoperow.edit', 'all'),
  (1, 'consultant', 'report.edit', 'all'),
  (1, 'consultant', 'report.view', 'all'),
  (1, 'consultant', 'actions.manage', 'all'),
  (1, 'consultant', 'srs.manage', 'all'),
  (1, 'consultant', 'finance.view', 'all'),
  (1, 'consultant', 'portal.admin', 'own_clients'),
  (1, 'consultant', 'clientfactor.manage', 'all'),
  (1, 'consultant', 'audit.view', 'own_clients'),
  (1, 'consultant', 'support.portal_impersonate', 'all'),
  (1, 'reviewer', 'client.view', 'all'),
  (1, 'reviewer', 'snapshot.review', 'all'),
  (1, 'reviewer', 'report.publish', 'all'),
  (1, 'reviewer', 'report.view', 'all'),
  (1, 'reviewer', 'audit.view', 'all'),
  (1, 'finance', 'client.view', 'all'),
  (1, 'finance', 'report.view', 'all'),
  (1, 'finance', 'finance.view', 'all'),
  (1, 'finance', 'finance.manage', 'all'),
  (1, 'finance', 'audit.view', 'own_clients'),
  (1, 'viewer', 'client.view', 'all'),
  (1, 'viewer', 'report.view', 'all');

-- Platform config, not tenant data: read by the auth role at sign-in and by the app.
GRANT SELECT ON nzi_console.staff_capability_matrix_versions, nzi_console.staff_role_capabilities TO nzi_console_auth, nzi_console_app;
REVOKE INSERT, UPDATE, DELETE ON nzi_console.staff_capability_matrix_versions, nzi_console.staff_role_capabilities
  FROM PUBLIC, nzi_console_app, nzi_console_auth, nzi_console_worker;

-- The canonical five roles. The retired names map by least privilege: administrator
-- → admin, read-only → viewer, and methodology-data-admin → viewer (its dataset
-- capability is Admin-only in the matrix; an Admin re-grants if needed).
ALTER TABLE nzi_console.memberships DROP CONSTRAINT memberships_role_id_check;
UPDATE nzi_console.memberships SET role_id = CASE role_id
  WHEN 'administrator' THEN 'admin'
  WHEN 'read-only' THEN 'viewer'
  WHEN 'methodology-data-admin' THEN 'viewer'
  ELSE role_id END;
ALTER TABLE nzi_console.memberships
  ADD CONSTRAINT memberships_role_id_check CHECK (role_id IN ('admin','consultant','reviewer','finance','viewer'));
-- Least privilege: a new staff user starts as Viewer.
ALTER TABLE nzi_console.memberships ALTER COLUMN role_id SET DEFAULT 'viewer';

-- "Own clients" (⚑ own): the staff user who owns the client. Backfilled from
-- whoever created the client; unowned clients are Admin-only for own-scoped
-- capabilities until an owner is assigned.
ALTER TABLE nzi_console.clients ADD COLUMN owner_user_id text;
ALTER TABLE nzi_console.clients
  ADD CONSTRAINT clients_owner_membership_fk FOREIGN KEY (organisation_id, owner_user_id)
  REFERENCES nzi_console.memberships (organisation_id, user_id);
UPDATE nzi_console.clients c SET owner_user_id = a.actor_id
FROM nzi_console.audit_events a
JOIN nzi_console.memberships m ON (m.organisation_id, m.user_id) = (a.organisation_id, a.actor_id)
WHERE a.action = 'client_created' AND a.entity_type = 'client'
  AND (a.organisation_id, a.entity_id) = (c.organisation_id, c.client_id)
  AND c.owner_user_id IS NULL;

-- Audit visibility for "own clients": the client an event concerns.
ALTER TABLE nzi_console.audit_events ADD COLUMN client_id text;
UPDATE nzi_console.audit_events SET client_id = entity_id WHERE entity_type = 'client' AND client_id IS NULL;
UPDATE nzi_console.audit_events a SET client_id = j.client_id
FROM nzi_console.jobs j
WHERE a.client_id IS NULL AND j.organisation_id = a.organisation_id
  AND j.job_id = coalesce(CASE WHEN a.entity_type = 'job' THEN a.entity_id END, a.after_json->>'jobId');
UPDATE nzi_console.audit_events SET client_id = after_json->>'clientId'
WHERE client_id IS NULL AND after_json ? 'clientId';
CREATE INDEX audit_events_client_idx ON nzi_console.audit_events (organisation_id, client_id, occurred_at DESC);

-- Separation of duties: a reviewed snapshot is prepared by `created_by` and approved
-- by someone else. A report may be validated or published only from an approved
-- snapshot, and not by its preparer (enforced in the command layer).
ALTER TABLE nzi_console.reviewed_crp_snapshots
  ADD COLUMN approved_by text,
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN approval_note text,
  ADD CONSTRAINT reviewed_crp_snapshots_approval_pair CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  ADD CONSTRAINT reviewed_crp_snapshots_independent_approval CHECK (approved_by IS NULL OR approved_by <> created_by);
GRANT UPDATE (approved_by, approved_at, approval_note) ON nzi_console.reviewed_crp_snapshots TO nzi_console_app;

ALTER TABLE nzi_console.report_versions
  ADD COLUMN validated_by text,
  ADD COLUMN published_by text;

-- Governed baseline changes (NZC-068): a re-baseline always carries a reason and is
-- recorded here as well as in the audit log. Append-only.
CREATE TABLE nzi_console.baseline_change_events (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  change_id text NOT NULL,
  client_id text NOT NULL,
  job_id text,
  subject text NOT NULL CHECK (subject IN ('client_baseline','job_emissions_target','job_intensity_target')),
  reason text NOT NULL CHECK (reason = trim(reason) AND reason <> ''),
  before_json jsonb NOT NULL,
  after_json jsonb NOT NULL,
  changed_by text NOT NULL,
  correlation_id text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, change_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id)
);
CREATE INDEX baseline_change_events_client_idx ON nzi_console.baseline_change_events (organisation_id, client_id, changed_at DESC);
ALTER TABLE nzi_console.baseline_change_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.baseline_change_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.baseline_change_events
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT ON nzi_console.baseline_change_events TO nzi_console_app;
REVOKE UPDATE, DELETE ON nzi_console.baseline_change_events FROM PUBLIC, nzi_console_app, nzi_console_auth, nzi_console_worker;

COMMIT;
