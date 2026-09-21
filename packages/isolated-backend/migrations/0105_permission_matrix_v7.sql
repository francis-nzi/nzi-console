BEGIN;

-- Permission matrix version 7.
--
-- Generated from ROLE_CAPABILITY_MATRIX by scripts/generate-matrix.ts, so the migration and
-- the code copy cannot disagree by transcription. A test holds them equal.
--
-- The matrix is migration-owned and versioned, so this is a NEW version rather than an edit
-- of the last one: a principal resolved against an earlier version keeps meaning what it
-- meant when it was resolved.
--
-- Adds subject.export and subject.erase — reading a person's data in the clear and destroying their key are separate acts from reviewing an identity question, and neither implies another (NZC-131).

INSERT INTO nzi_console.staff_capability_matrix_versions (matrix_version, source, note)
VALUES (7, 'docs/PERMISSION_MATRIX.md', 'Adds subject.export and subject.erase — reading a person''s data in the clear and destroying their key are separate acts from reviewing an identity question, and neither implies another (NZC-131).');

INSERT INTO nzi_console.staff_role_capabilities (matrix_version, role_id, capability, scope) VALUES
  (7, 'admin', 'client.view', 'all'),
  (7, 'admin', 'client.create', 'all'),
  (7, 'admin', 'client.edit', 'all'),
  (7, 'admin', 'client.deactivate', 'all'),
  (7, 'admin', 'contact.manage', 'all'),
  (7, 'admin', 'site.manage', 'all'),
  (7, 'admin', 'target.edit', 'all'),
  (7, 'admin', 'baseline.rebaseline', 'all'),
  (7, 'admin', 'job.manage', 'all'),
  (7, 'admin', 'scoperow.edit', 'all'),
  (7, 'admin', 'snapshot.review', 'all'),
  (7, 'admin', 'report.edit', 'all'),
  (7, 'admin', 'report.publish', 'all'),
  (7, 'admin', 'report.view', 'all'),
  (7, 'admin', 'strategy.manage', 'all'),
  (7, 'admin', 'srs.manage', 'all'),
  (7, 'admin', 'training.manage', 'all'),
  (7, 'admin', 'training.entitlement.manage', 'all'),
  (7, 'admin', 'finance.view', 'all'),
  (7, 'admin', 'finance.manage', 'all'),
  (7, 'admin', 'portal.admin', 'all'),
  (7, 'admin', 'category.visibility', 'all'),
  (7, 'admin', 'subject.review', 'all'),
  (7, 'admin', 'subject.export', 'all'),
  (7, 'admin', 'subject.erase', 'all'),
  (7, 'admin', 'clientfactor.manage', 'all'),
  (7, 'admin', 'dataset.manage', 'all'),
  (7, 'admin', 'factor.manage', 'all'),
  (7, 'admin', 'admin.users', 'all'),
  (7, 'admin', 'admin.lookups', 'all'),
  (7, 'admin', 'admin.templates', 'all'),
  (7, 'admin', 'admin.settings', 'all'),
  (7, 'admin', 'audit.view', 'all'),
  (7, 'admin', 'support.portal_impersonate', 'all'),
  (7, 'admin', 'knowledge.capture', 'all'),
  (7, 'admin', 'knowledge.approve', 'all'),
  (7, 'admin', 'knowledge.publish', 'all'),
  (7, 'consultant', 'client.view', 'all'),
  (7, 'consultant', 'client.create', 'all'),
  (7, 'consultant', 'client.edit', 'all'),
  (7, 'consultant', 'contact.manage', 'all'),
  (7, 'consultant', 'site.manage', 'all'),
  (7, 'consultant', 'target.edit', 'all'),
  (7, 'consultant', 'job.manage', 'all'),
  (7, 'consultant', 'scoperow.edit', 'all'),
  (7, 'consultant', 'report.edit', 'all'),
  (7, 'consultant', 'report.view', 'all'),
  (7, 'consultant', 'strategy.manage', 'all'),
  (7, 'consultant', 'srs.manage', 'all'),
  (7, 'consultant', 'training.manage', 'all'),
  (7, 'consultant', 'training.entitlement.manage', 'all'),
  (7, 'consultant', 'finance.view', 'all'),
  (7, 'consultant', 'clientfactor.manage', 'all'),
  (7, 'consultant', 'support.portal_impersonate', 'all'),
  (7, 'consultant', 'knowledge.capture', 'all'),
  (7, 'consultant', 'knowledge.approve', 'all'),
  (7, 'consultant', 'baseline.rebaseline', 'own_clients'),
  (7, 'consultant', 'portal.admin', 'own_clients'),
  (7, 'consultant', 'category.visibility', 'own_clients'),
  (7, 'consultant', 'audit.view', 'own_clients'),
  (7, 'reviewer', 'client.view', 'all'),
  (7, 'reviewer', 'snapshot.review', 'all'),
  (7, 'reviewer', 'report.publish', 'all'),
  (7, 'reviewer', 'report.view', 'all'),
  (7, 'reviewer', 'audit.view', 'all'),
  (7, 'reviewer', 'knowledge.capture', 'all'),
  (7, 'finance', 'client.view', 'all'),
  (7, 'finance', 'report.view', 'all'),
  (7, 'finance', 'finance.view', 'all'),
  (7, 'finance', 'finance.manage', 'all'),
  (7, 'finance', 'knowledge.capture', 'all'),
  (7, 'finance', 'audit.view', 'own_clients'),
  (7, 'viewer', 'client.view', 'all'),
  (7, 'viewer', 'report.view', 'all'),
  (7, 'viewer', 'knowledge.capture', 'all');

COMMIT;
