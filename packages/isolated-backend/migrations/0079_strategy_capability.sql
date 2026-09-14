BEGIN;

-- Permission matrix version 3.
--
-- Generated from ROLE_CAPABILITY_MATRIX by scripts/generate-matrix.ts, so the migration and
-- the code copy cannot disagree by transcription. A test holds them equal.
--
-- The matrix is migration-owned and versioned, so this is a NEW version rather than an edit
-- of the last one: a principal resolved against an earlier version keeps meaning what it
-- meant when it was resolved.
--
-- Renames actions.manage to strategy.manage for the Reduction Strategies area (NZC-075); held by Admin and Consultant, exactly as actions.manage was.

INSERT INTO nzi_console.staff_capability_matrix_versions (matrix_version, source, note)
VALUES (3, 'docs/PERMISSION_MATRIX.md', 'Renames actions.manage to strategy.manage for the Reduction Strategies area (NZC-075); held by Admin and Consultant, exactly as actions.manage was.');

INSERT INTO nzi_console.staff_role_capabilities (matrix_version, role_id, capability, scope) VALUES
  (3, 'admin', 'client.view', 'all'),
  (3, 'admin', 'client.create', 'all'),
  (3, 'admin', 'client.edit', 'all'),
  (3, 'admin', 'client.deactivate', 'all'),
  (3, 'admin', 'contact.manage', 'all'),
  (3, 'admin', 'site.manage', 'all'),
  (3, 'admin', 'target.edit', 'all'),
  (3, 'admin', 'baseline.rebaseline', 'all'),
  (3, 'admin', 'job.manage', 'all'),
  (3, 'admin', 'scoperow.edit', 'all'),
  (3, 'admin', 'snapshot.review', 'all'),
  (3, 'admin', 'report.edit', 'all'),
  (3, 'admin', 'report.publish', 'all'),
  (3, 'admin', 'report.view', 'all'),
  (3, 'admin', 'strategy.manage', 'all'),
  (3, 'admin', 'srs.manage', 'all'),
  (3, 'admin', 'training.manage', 'all'),
  (3, 'admin', 'training.entitlement.manage', 'all'),
  (3, 'admin', 'finance.view', 'all'),
  (3, 'admin', 'finance.manage', 'all'),
  (3, 'admin', 'portal.admin', 'all'),
  (3, 'admin', 'clientfactor.manage', 'all'),
  (3, 'admin', 'dataset.manage', 'all'),
  (3, 'admin', 'factor.manage', 'all'),
  (3, 'admin', 'admin.users', 'all'),
  (3, 'admin', 'admin.lookups', 'all'),
  (3, 'admin', 'admin.templates', 'all'),
  (3, 'admin', 'admin.settings', 'all'),
  (3, 'admin', 'audit.view', 'all'),
  (3, 'admin', 'support.portal_impersonate', 'all'),
  (3, 'consultant', 'client.view', 'all'),
  (3, 'consultant', 'client.create', 'all'),
  (3, 'consultant', 'client.edit', 'all'),
  (3, 'consultant', 'contact.manage', 'all'),
  (3, 'consultant', 'site.manage', 'all'),
  (3, 'consultant', 'target.edit', 'all'),
  (3, 'consultant', 'job.manage', 'all'),
  (3, 'consultant', 'scoperow.edit', 'all'),
  (3, 'consultant', 'report.edit', 'all'),
  (3, 'consultant', 'report.view', 'all'),
  (3, 'consultant', 'strategy.manage', 'all'),
  (3, 'consultant', 'srs.manage', 'all'),
  (3, 'consultant', 'training.manage', 'all'),
  (3, 'consultant', 'training.entitlement.manage', 'all'),
  (3, 'consultant', 'finance.view', 'all'),
  (3, 'consultant', 'clientfactor.manage', 'all'),
  (3, 'consultant', 'support.portal_impersonate', 'all'),
  (3, 'consultant', 'baseline.rebaseline', 'own_clients'),
  (3, 'consultant', 'portal.admin', 'own_clients'),
  (3, 'consultant', 'audit.view', 'own_clients'),
  (3, 'reviewer', 'client.view', 'all'),
  (3, 'reviewer', 'snapshot.review', 'all'),
  (3, 'reviewer', 'report.publish', 'all'),
  (3, 'reviewer', 'report.view', 'all'),
  (3, 'reviewer', 'audit.view', 'all'),
  (3, 'finance', 'client.view', 'all'),
  (3, 'finance', 'report.view', 'all'),
  (3, 'finance', 'finance.view', 'all'),
  (3, 'finance', 'finance.manage', 'all'),
  (3, 'finance', 'audit.view', 'own_clients'),
  (3, 'viewer', 'client.view', 'all'),
  (3, 'viewer', 'report.view', 'all');

COMMIT;
