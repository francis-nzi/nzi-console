BEGIN;

-- NZC-073 — Training gets its own capabilities, and the matrix moves to version 2.
--
-- Training is a module in exactly the sense that Actions and SRS Readiness are, and both of
-- those already carry their own capability. Running training off the generic job.manage was
-- the deviation: it meant anyone who could manage a job could issue NZI-branded verifiable
-- certificates. It also put moving a place's expiry under finance.manage, so Finance could
-- extend a place the delivering consultant could not — backwards, because extending an
-- already-granted place is an operational concession, not a commercial re-sale.
--
--   training.manage              bookings, attendance, stage transitions, certificate issuance
--   training.entitlement.manage  moving a place's expiry off its job-end default
--
-- Two things deliberately do NOT move:
--   * Reviewing a run stays snapshot.review. The consultant who delivers the course and
--     issues its certificates must not also approve the reviewed snapshot — the same
--     separation of duties that governs every other reviewed unit.
--   * Certificate issuance stays policy-gated on top of the capability: attendance decides
--     and consent holds. The capability says who may run the command; the policy decides
--     the outcome.
--
-- The matrix is migration-owned and versioned, so this is a new version rather than an edit
-- of version 1: a principal resolved against version 1 keeps meaning what it meant.

-- A capability may now carry more than one dot (training.entitlement.manage); the previous
-- pattern allowed exactly one and would have rejected it.
ALTER TABLE nzi_console.staff_role_capabilities DROP CONSTRAINT staff_role_capabilities_capability_check;
ALTER TABLE nzi_console.staff_role_capabilities
  ADD CONSTRAINT staff_role_capabilities_capability_check CHECK (capability ~ '^[a-z]+(\.[a-z_]+)+$');

INSERT INTO nzi_console.staff_capability_matrix_versions (matrix_version, source, note)
VALUES (2, 'docs/PERMISSION_MATRIX.md', 'Adds training.manage and training.entitlement.manage, held by Admin and Consultant; run review stays snapshot.review (NZC-073).');

INSERT INTO nzi_console.staff_role_capabilities (matrix_version, role_id, capability, scope) VALUES
  (2, 'admin', 'client.view', 'all'),
  (2, 'admin', 'client.create', 'all'),
  (2, 'admin', 'client.edit', 'all'),
  (2, 'admin', 'client.deactivate', 'all'),
  (2, 'admin', 'contact.manage', 'all'),
  (2, 'admin', 'site.manage', 'all'),
  (2, 'admin', 'target.edit', 'all'),
  (2, 'admin', 'baseline.rebaseline', 'all'),
  (2, 'admin', 'job.manage', 'all'),
  (2, 'admin', 'scoperow.edit', 'all'),
  (2, 'admin', 'snapshot.review', 'all'),
  (2, 'admin', 'report.edit', 'all'),
  (2, 'admin', 'report.publish', 'all'),
  (2, 'admin', 'report.view', 'all'),
  (2, 'admin', 'actions.manage', 'all'),
  (2, 'admin', 'srs.manage', 'all'),
  (2, 'admin', 'training.manage', 'all'),
  (2, 'admin', 'training.entitlement.manage', 'all'),
  (2, 'admin', 'finance.view', 'all'),
  (2, 'admin', 'finance.manage', 'all'),
  (2, 'admin', 'portal.admin', 'all'),
  (2, 'admin', 'clientfactor.manage', 'all'),
  (2, 'admin', 'dataset.manage', 'all'),
  (2, 'admin', 'factor.manage', 'all'),
  (2, 'admin', 'admin.users', 'all'),
  (2, 'admin', 'admin.lookups', 'all'),
  (2, 'admin', 'admin.templates', 'all'),
  (2, 'admin', 'admin.settings', 'all'),
  (2, 'admin', 'audit.view', 'all'),
  (2, 'admin', 'support.portal_impersonate', 'all'),
  (2, 'consultant', 'client.view', 'all'),
  (2, 'consultant', 'client.create', 'all'),
  (2, 'consultant', 'client.edit', 'all'),
  (2, 'consultant', 'contact.manage', 'all'),
  (2, 'consultant', 'site.manage', 'all'),
  (2, 'consultant', 'target.edit', 'all'),
  (2, 'consultant', 'job.manage', 'all'),
  (2, 'consultant', 'scoperow.edit', 'all'),
  (2, 'consultant', 'report.edit', 'all'),
  (2, 'consultant', 'report.view', 'all'),
  (2, 'consultant', 'actions.manage', 'all'),
  (2, 'consultant', 'srs.manage', 'all'),
  (2, 'consultant', 'training.manage', 'all'),
  (2, 'consultant', 'training.entitlement.manage', 'all'),
  (2, 'consultant', 'finance.view', 'all'),
  (2, 'consultant', 'clientfactor.manage', 'all'),
  (2, 'consultant', 'support.portal_impersonate', 'all'),
  (2, 'consultant', 'baseline.rebaseline', 'own_clients'),
  (2, 'consultant', 'portal.admin', 'own_clients'),
  (2, 'consultant', 'audit.view', 'own_clients'),
  (2, 'reviewer', 'client.view', 'all'),
  (2, 'reviewer', 'snapshot.review', 'all'),
  (2, 'reviewer', 'report.publish', 'all'),
  (2, 'reviewer', 'report.view', 'all'),
  (2, 'reviewer', 'audit.view', 'all'),
  (2, 'finance', 'client.view', 'all'),
  (2, 'finance', 'report.view', 'all'),
  (2, 'finance', 'finance.view', 'all'),
  (2, 'finance', 'finance.manage', 'all'),
  (2, 'finance', 'audit.view', 'own_clients'),
  (2, 'viewer', 'client.view', 'all'),
  (2, 'viewer', 'report.view', 'all');

COMMIT;
