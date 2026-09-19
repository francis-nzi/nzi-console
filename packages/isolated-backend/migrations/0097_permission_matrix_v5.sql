BEGIN;

-- Permission matrix version 5.
--
-- Generated from ROLE_CAPABILITY_MATRIX by scripts/generate-matrix.ts, so the migration and
-- the code copy cannot disagree by transcription. A test holds them equal.
--
-- The matrix is migration-owned and versioned, so this is a NEW version rather than an edit
-- of the last one: a principal resolved against an earlier version keeps meaning what it
-- meant when it was resolved.
--
-- Adds category.visibility — deciding what a client sees of the category list is a disclosure decision, not portal-user administration (NZC-110).

INSERT INTO nzi_console.staff_capability_matrix_versions (matrix_version, source, note)
VALUES (5, 'docs/PERMISSION_MATRIX.md', 'Adds category.visibility — deciding what a client sees of the category list is a disclosure decision, not portal-user administration (NZC-110).');

INSERT INTO nzi_console.staff_role_capabilities (matrix_version, role_id, capability, scope) VALUES
  (5, 'admin', 'client.view', 'all'),
  (5, 'admin', 'client.create', 'all'),
  (5, 'admin', 'client.edit', 'all'),
  (5, 'admin', 'client.deactivate', 'all'),
  (5, 'admin', 'contact.manage', 'all'),
  (5, 'admin', 'site.manage', 'all'),
  (5, 'admin', 'target.edit', 'all'),
  (5, 'admin', 'baseline.rebaseline', 'all'),
  (5, 'admin', 'job.manage', 'all'),
  (5, 'admin', 'scoperow.edit', 'all'),
  (5, 'admin', 'snapshot.review', 'all'),
  (5, 'admin', 'report.edit', 'all'),
  (5, 'admin', 'report.publish', 'all'),
  (5, 'admin', 'report.view', 'all'),
  (5, 'admin', 'strategy.manage', 'all'),
  (5, 'admin', 'srs.manage', 'all'),
  (5, 'admin', 'training.manage', 'all'),
  (5, 'admin', 'training.entitlement.manage', 'all'),
  (5, 'admin', 'finance.view', 'all'),
  (5, 'admin', 'finance.manage', 'all'),
  (5, 'admin', 'portal.admin', 'all'),
  (5, 'admin', 'category.visibility', 'all'),
  (5, 'admin', 'clientfactor.manage', 'all'),
  (5, 'admin', 'dataset.manage', 'all'),
  (5, 'admin', 'factor.manage', 'all'),
  (5, 'admin', 'admin.users', 'all'),
  (5, 'admin', 'admin.lookups', 'all'),
  (5, 'admin', 'admin.templates', 'all'),
  (5, 'admin', 'admin.settings', 'all'),
  (5, 'admin', 'audit.view', 'all'),
  (5, 'admin', 'support.portal_impersonate', 'all'),
  (5, 'admin', 'knowledge.capture', 'all'),
  (5, 'admin', 'knowledge.approve', 'all'),
  (5, 'admin', 'knowledge.publish', 'all'),
  (5, 'consultant', 'client.view', 'all'),
  (5, 'consultant', 'client.create', 'all'),
  (5, 'consultant', 'client.edit', 'all'),
  (5, 'consultant', 'contact.manage', 'all'),
  (5, 'consultant', 'site.manage', 'all'),
  (5, 'consultant', 'target.edit', 'all'),
  (5, 'consultant', 'job.manage', 'all'),
  (5, 'consultant', 'scoperow.edit', 'all'),
  (5, 'consultant', 'report.edit', 'all'),
  (5, 'consultant', 'report.view', 'all'),
  (5, 'consultant', 'strategy.manage', 'all'),
  (5, 'consultant', 'srs.manage', 'all'),
  (5, 'consultant', 'training.manage', 'all'),
  (5, 'consultant', 'training.entitlement.manage', 'all'),
  (5, 'consultant', 'finance.view', 'all'),
  (5, 'consultant', 'clientfactor.manage', 'all'),
  (5, 'consultant', 'support.portal_impersonate', 'all'),
  (5, 'consultant', 'knowledge.capture', 'all'),
  (5, 'consultant', 'knowledge.approve', 'all'),
  (5, 'consultant', 'baseline.rebaseline', 'own_clients'),
  (5, 'consultant', 'portal.admin', 'own_clients'),
  (5, 'consultant', 'category.visibility', 'own_clients'),
  (5, 'consultant', 'audit.view', 'own_clients'),
  (5, 'reviewer', 'client.view', 'all'),
  (5, 'reviewer', 'snapshot.review', 'all'),
  (5, 'reviewer', 'report.publish', 'all'),
  (5, 'reviewer', 'report.view', 'all'),
  (5, 'reviewer', 'audit.view', 'all'),
  (5, 'reviewer', 'knowledge.capture', 'all'),
  (5, 'finance', 'client.view', 'all'),
  (5, 'finance', 'report.view', 'all'),
  (5, 'finance', 'finance.view', 'all'),
  (5, 'finance', 'finance.manage', 'all'),
  (5, 'finance', 'knowledge.capture', 'all'),
  (5, 'finance', 'audit.view', 'own_clients'),
  (5, 'viewer', 'client.view', 'all'),
  (5, 'viewer', 'report.view', 'all'),
  (5, 'viewer', 'knowledge.capture', 'all');

COMMIT;
