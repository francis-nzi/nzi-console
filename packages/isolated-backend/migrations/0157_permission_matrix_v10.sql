BEGIN;

-- Permission matrix version 10.
--
-- Generated from ROLE_CAPABILITY_MATRIX by scripts/generate-matrix.ts, so the migration and
-- the code copy cannot disagree by transcription. A test holds them equal.
--
-- The matrix is migration-owned and versioned, so this is a NEW version rather than an edit
-- of the last one: a principal resolved against an earlier version keeps meaning what it
-- meant when it was resolved.
--
-- v10 — Time PR B: Finance gains time.view (all) so payroll and job cost read the whole team's hours (Time PR A flag #1).

INSERT INTO nzi_console.staff_capability_matrix_versions (matrix_version, source, note)
VALUES (10, 'docs/PERMISSION_MATRIX.md', 'v10 — Time PR B: Finance gains time.view (all) so payroll and job cost read the whole team''s hours (Time PR A flag #1).');

INSERT INTO nzi_console.staff_role_capabilities (matrix_version, role_id, capability, scope) VALUES
  (10, 'admin', 'client.view', 'all'),
  (10, 'admin', 'client.create', 'all'),
  (10, 'admin', 'client.edit', 'all'),
  (10, 'admin', 'client.deactivate', 'all'),
  (10, 'admin', 'contact.manage', 'all'),
  (10, 'admin', 'site.manage', 'all'),
  (10, 'admin', 'target.edit', 'all'),
  (10, 'admin', 'baseline.rebaseline', 'all'),
  (10, 'admin', 'job.manage', 'all'),
  (10, 'admin', 'scoperow.edit', 'all'),
  (10, 'admin', 'snapshot.review', 'all'),
  (10, 'admin', 'report.edit', 'all'),
  (10, 'admin', 'report.publish', 'all'),
  (10, 'admin', 'report.view', 'all'),
  (10, 'admin', 'strategy.manage', 'all'),
  (10, 'admin', 'srs.manage', 'all'),
  (10, 'admin', 'training.manage', 'all'),
  (10, 'admin', 'training.entitlement.manage', 'all'),
  (10, 'admin', 'finance.view', 'all'),
  (10, 'admin', 'finance.manage', 'all'),
  (10, 'admin', 'portal.admin', 'all'),
  (10, 'admin', 'category.visibility', 'all'),
  (10, 'admin', 'subject.review', 'all'),
  (10, 'admin', 'subject.export', 'all'),
  (10, 'admin', 'subject.erase', 'all'),
  (10, 'admin', 'clientfactor.manage', 'all'),
  (10, 'admin', 'dataset.manage', 'all'),
  (10, 'admin', 'factor.manage', 'all'),
  (10, 'admin', 'admin.users', 'all'),
  (10, 'admin', 'staff.invite', 'all'),
  (10, 'admin', 'admin.lookups', 'all'),
  (10, 'admin', 'admin.templates', 'all'),
  (10, 'admin', 'admin.settings', 'all'),
  (10, 'admin', 'audit.view', 'all'),
  (10, 'admin', 'support.portal_impersonate', 'all'),
  (10, 'admin', 'knowledge.capture', 'all'),
  (10, 'admin', 'knowledge.approve', 'all'),
  (10, 'admin', 'knowledge.publish', 'all'),
  (10, 'admin', 'time.log', 'all'),
  (10, 'admin', 'time.view', 'all'),
  (10, 'consultant', 'client.view', 'all'),
  (10, 'consultant', 'client.create', 'all'),
  (10, 'consultant', 'client.edit', 'all'),
  (10, 'consultant', 'contact.manage', 'all'),
  (10, 'consultant', 'site.manage', 'all'),
  (10, 'consultant', 'target.edit', 'all'),
  (10, 'consultant', 'job.manage', 'all'),
  (10, 'consultant', 'scoperow.edit', 'all'),
  (10, 'consultant', 'report.edit', 'all'),
  (10, 'consultant', 'report.view', 'all'),
  (10, 'consultant', 'strategy.manage', 'all'),
  (10, 'consultant', 'srs.manage', 'all'),
  (10, 'consultant', 'training.manage', 'all'),
  (10, 'consultant', 'training.entitlement.manage', 'all'),
  (10, 'consultant', 'finance.view', 'all'),
  (10, 'consultant', 'clientfactor.manage', 'all'),
  (10, 'consultant', 'support.portal_impersonate', 'all'),
  (10, 'consultant', 'knowledge.capture', 'all'),
  (10, 'consultant', 'knowledge.approve', 'all'),
  (10, 'consultant', 'baseline.rebaseline', 'own_clients'),
  (10, 'consultant', 'portal.admin', 'own_clients'),
  (10, 'consultant', 'category.visibility', 'own_clients'),
  (10, 'consultant', 'audit.view', 'own_clients'),
  (10, 'consultant', 'time.log', 'own_clients'),
  (10, 'consultant', 'time.view', 'own_clients'),
  (10, 'reviewer', 'client.view', 'all'),
  (10, 'reviewer', 'snapshot.review', 'all'),
  (10, 'reviewer', 'report.publish', 'all'),
  (10, 'reviewer', 'report.view', 'all'),
  (10, 'reviewer', 'audit.view', 'all'),
  (10, 'reviewer', 'knowledge.capture', 'all'),
  (10, 'reviewer', 'time.log', 'all'),
  (10, 'reviewer', 'time.view', 'all'),
  (10, 'finance', 'client.view', 'all'),
  (10, 'finance', 'report.view', 'all'),
  (10, 'finance', 'finance.view', 'all'),
  (10, 'finance', 'finance.manage', 'all'),
  (10, 'finance', 'knowledge.capture', 'all'),
  (10, 'finance', 'time.log', 'all'),
  (10, 'finance', 'time.view', 'all'),
  (10, 'finance', 'audit.view', 'own_clients'),
  (10, 'viewer', 'client.view', 'all'),
  (10, 'viewer', 'report.view', 'all'),
  (10, 'viewer', 'knowledge.capture', 'all'),
  (10, 'viewer', 'time.log', 'all');

COMMIT;
