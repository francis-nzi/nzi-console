BEGIN;

-- Permission matrix version 9.
--
-- Generated from ROLE_CAPABILITY_MATRIX by scripts/generate-matrix.ts, so the migration and
-- the code copy cannot disagree by transcription. A test holds them equal.
--
-- The matrix is migration-owned and versioned, so this is a NEW version rather than an edit
-- of the last one: a principal resolved against an earlier version keeps meaning what it
-- meant when it was resolved.
--
-- Adds time.log (log, edit and void one's own time against a job one can access: every role; a consultant on their own clients' jobs) and time.view (see others' time: Admin and Reviewer all, a consultant on their own clients' jobs). TIME-module rulings T-Q3, T-Q7. Money on time stays behind finance.view / finance.manage.

INSERT INTO nzi_console.staff_capability_matrix_versions (matrix_version, source, note)
VALUES (9, 'docs/PERMISSION_MATRIX.md', 'Adds time.log (log, edit and void one''s own time against a job one can access: every role; a consultant on their own clients'' jobs) and time.view (see others'' time: Admin and Reviewer all, a consultant on their own clients'' jobs). TIME-module rulings T-Q3, T-Q7. Money on time stays behind finance.view / finance.manage.');

INSERT INTO nzi_console.staff_role_capabilities (matrix_version, role_id, capability, scope) VALUES
  (9, 'admin', 'client.view', 'all'),
  (9, 'admin', 'client.create', 'all'),
  (9, 'admin', 'client.edit', 'all'),
  (9, 'admin', 'client.deactivate', 'all'),
  (9, 'admin', 'contact.manage', 'all'),
  (9, 'admin', 'site.manage', 'all'),
  (9, 'admin', 'target.edit', 'all'),
  (9, 'admin', 'baseline.rebaseline', 'all'),
  (9, 'admin', 'job.manage', 'all'),
  (9, 'admin', 'scoperow.edit', 'all'),
  (9, 'admin', 'snapshot.review', 'all'),
  (9, 'admin', 'report.edit', 'all'),
  (9, 'admin', 'report.publish', 'all'),
  (9, 'admin', 'report.view', 'all'),
  (9, 'admin', 'strategy.manage', 'all'),
  (9, 'admin', 'srs.manage', 'all'),
  (9, 'admin', 'training.manage', 'all'),
  (9, 'admin', 'training.entitlement.manage', 'all'),
  (9, 'admin', 'finance.view', 'all'),
  (9, 'admin', 'finance.manage', 'all'),
  (9, 'admin', 'portal.admin', 'all'),
  (9, 'admin', 'category.visibility', 'all'),
  (9, 'admin', 'subject.review', 'all'),
  (9, 'admin', 'subject.export', 'all'),
  (9, 'admin', 'subject.erase', 'all'),
  (9, 'admin', 'clientfactor.manage', 'all'),
  (9, 'admin', 'dataset.manage', 'all'),
  (9, 'admin', 'factor.manage', 'all'),
  (9, 'admin', 'admin.users', 'all'),
  (9, 'admin', 'staff.invite', 'all'),
  (9, 'admin', 'admin.lookups', 'all'),
  (9, 'admin', 'admin.templates', 'all'),
  (9, 'admin', 'admin.settings', 'all'),
  (9, 'admin', 'audit.view', 'all'),
  (9, 'admin', 'support.portal_impersonate', 'all'),
  (9, 'admin', 'knowledge.capture', 'all'),
  (9, 'admin', 'knowledge.approve', 'all'),
  (9, 'admin', 'knowledge.publish', 'all'),
  (9, 'admin', 'time.log', 'all'),
  (9, 'admin', 'time.view', 'all'),
  (9, 'consultant', 'client.view', 'all'),
  (9, 'consultant', 'client.create', 'all'),
  (9, 'consultant', 'client.edit', 'all'),
  (9, 'consultant', 'contact.manage', 'all'),
  (9, 'consultant', 'site.manage', 'all'),
  (9, 'consultant', 'target.edit', 'all'),
  (9, 'consultant', 'job.manage', 'all'),
  (9, 'consultant', 'scoperow.edit', 'all'),
  (9, 'consultant', 'report.edit', 'all'),
  (9, 'consultant', 'report.view', 'all'),
  (9, 'consultant', 'strategy.manage', 'all'),
  (9, 'consultant', 'srs.manage', 'all'),
  (9, 'consultant', 'training.manage', 'all'),
  (9, 'consultant', 'training.entitlement.manage', 'all'),
  (9, 'consultant', 'finance.view', 'all'),
  (9, 'consultant', 'clientfactor.manage', 'all'),
  (9, 'consultant', 'support.portal_impersonate', 'all'),
  (9, 'consultant', 'knowledge.capture', 'all'),
  (9, 'consultant', 'knowledge.approve', 'all'),
  (9, 'consultant', 'baseline.rebaseline', 'own_clients'),
  (9, 'consultant', 'portal.admin', 'own_clients'),
  (9, 'consultant', 'category.visibility', 'own_clients'),
  (9, 'consultant', 'audit.view', 'own_clients'),
  (9, 'consultant', 'time.log', 'own_clients'),
  (9, 'consultant', 'time.view', 'own_clients'),
  (9, 'reviewer', 'client.view', 'all'),
  (9, 'reviewer', 'snapshot.review', 'all'),
  (9, 'reviewer', 'report.publish', 'all'),
  (9, 'reviewer', 'report.view', 'all'),
  (9, 'reviewer', 'audit.view', 'all'),
  (9, 'reviewer', 'knowledge.capture', 'all'),
  (9, 'reviewer', 'time.log', 'all'),
  (9, 'reviewer', 'time.view', 'all'),
  (9, 'finance', 'client.view', 'all'),
  (9, 'finance', 'report.view', 'all'),
  (9, 'finance', 'finance.view', 'all'),
  (9, 'finance', 'finance.manage', 'all'),
  (9, 'finance', 'knowledge.capture', 'all'),
  (9, 'finance', 'time.log', 'all'),
  (9, 'finance', 'audit.view', 'own_clients'),
  (9, 'viewer', 'client.view', 'all'),
  (9, 'viewer', 'report.view', 'all'),
  (9, 'viewer', 'knowledge.capture', 'all'),
  (9, 'viewer', 'time.log', 'all');

COMMIT;
