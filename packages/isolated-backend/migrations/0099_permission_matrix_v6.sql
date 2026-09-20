BEGIN;

-- Permission matrix version 6.
--
-- Generated from ROLE_CAPABILITY_MATRIX by scripts/generate-matrix.ts, so the migration and
-- the code copy cannot disagree by transcription. A test holds them equal.
--
-- The matrix is migration-owned and versioned, so this is a NEW version rather than an edit
-- of the last one: a principal resolved against an earlier version keeps meaning what it
-- meant when it was resolved.
--
-- Adds subject.review — identity questions for the erasure spine, admin only and spanning organisations (NZC-116).

INSERT INTO nzi_console.staff_capability_matrix_versions (matrix_version, source, note)
VALUES (6, 'docs/PERMISSION_MATRIX.md', 'Adds subject.review — identity questions for the erasure spine, admin only and spanning organisations (NZC-116).');

INSERT INTO nzi_console.staff_role_capabilities (matrix_version, role_id, capability, scope) VALUES
  (6, 'admin', 'client.view', 'all'),
  (6, 'admin', 'client.create', 'all'),
  (6, 'admin', 'client.edit', 'all'),
  (6, 'admin', 'client.deactivate', 'all'),
  (6, 'admin', 'contact.manage', 'all'),
  (6, 'admin', 'site.manage', 'all'),
  (6, 'admin', 'target.edit', 'all'),
  (6, 'admin', 'baseline.rebaseline', 'all'),
  (6, 'admin', 'job.manage', 'all'),
  (6, 'admin', 'scoperow.edit', 'all'),
  (6, 'admin', 'snapshot.review', 'all'),
  (6, 'admin', 'report.edit', 'all'),
  (6, 'admin', 'report.publish', 'all'),
  (6, 'admin', 'report.view', 'all'),
  (6, 'admin', 'strategy.manage', 'all'),
  (6, 'admin', 'srs.manage', 'all'),
  (6, 'admin', 'training.manage', 'all'),
  (6, 'admin', 'training.entitlement.manage', 'all'),
  (6, 'admin', 'finance.view', 'all'),
  (6, 'admin', 'finance.manage', 'all'),
  (6, 'admin', 'portal.admin', 'all'),
  (6, 'admin', 'category.visibility', 'all'),
  (6, 'admin', 'subject.review', 'all'),
  (6, 'admin', 'clientfactor.manage', 'all'),
  (6, 'admin', 'dataset.manage', 'all'),
  (6, 'admin', 'factor.manage', 'all'),
  (6, 'admin', 'admin.users', 'all'),
  (6, 'admin', 'admin.lookups', 'all'),
  (6, 'admin', 'admin.templates', 'all'),
  (6, 'admin', 'admin.settings', 'all'),
  (6, 'admin', 'audit.view', 'all'),
  (6, 'admin', 'support.portal_impersonate', 'all'),
  (6, 'admin', 'knowledge.capture', 'all'),
  (6, 'admin', 'knowledge.approve', 'all'),
  (6, 'admin', 'knowledge.publish', 'all'),
  (6, 'consultant', 'client.view', 'all'),
  (6, 'consultant', 'client.create', 'all'),
  (6, 'consultant', 'client.edit', 'all'),
  (6, 'consultant', 'contact.manage', 'all'),
  (6, 'consultant', 'site.manage', 'all'),
  (6, 'consultant', 'target.edit', 'all'),
  (6, 'consultant', 'job.manage', 'all'),
  (6, 'consultant', 'scoperow.edit', 'all'),
  (6, 'consultant', 'report.edit', 'all'),
  (6, 'consultant', 'report.view', 'all'),
  (6, 'consultant', 'strategy.manage', 'all'),
  (6, 'consultant', 'srs.manage', 'all'),
  (6, 'consultant', 'training.manage', 'all'),
  (6, 'consultant', 'training.entitlement.manage', 'all'),
  (6, 'consultant', 'finance.view', 'all'),
  (6, 'consultant', 'clientfactor.manage', 'all'),
  (6, 'consultant', 'support.portal_impersonate', 'all'),
  (6, 'consultant', 'knowledge.capture', 'all'),
  (6, 'consultant', 'knowledge.approve', 'all'),
  (6, 'consultant', 'baseline.rebaseline', 'own_clients'),
  (6, 'consultant', 'portal.admin', 'own_clients'),
  (6, 'consultant', 'category.visibility', 'own_clients'),
  (6, 'consultant', 'audit.view', 'own_clients'),
  (6, 'reviewer', 'client.view', 'all'),
  (6, 'reviewer', 'snapshot.review', 'all'),
  (6, 'reviewer', 'report.publish', 'all'),
  (6, 'reviewer', 'report.view', 'all'),
  (6, 'reviewer', 'audit.view', 'all'),
  (6, 'reviewer', 'knowledge.capture', 'all'),
  (6, 'finance', 'client.view', 'all'),
  (6, 'finance', 'report.view', 'all'),
  (6, 'finance', 'finance.view', 'all'),
  (6, 'finance', 'finance.manage', 'all'),
  (6, 'finance', 'knowledge.capture', 'all'),
  (6, 'finance', 'audit.view', 'own_clients'),
  (6, 'viewer', 'client.view', 'all'),
  (6, 'viewer', 'report.view', 'all'),
  (6, 'viewer', 'knowledge.capture', 'all');

COMMIT;
