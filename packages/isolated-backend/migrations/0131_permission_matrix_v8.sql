BEGIN;

-- Permission matrix version 8.
--
-- Generated from ROLE_CAPABILITY_MATRIX by scripts/generate-matrix.ts, so the migration and
-- the code copy cannot disagree by transcription. A test holds them equal.
--
-- The matrix is migration-owned and versioned, so this is a NEW version rather than an edit
-- of the last one: a principal resolved against an earlier version keeps meaning what it
-- meant when it was resolved.
--
-- Adds staff.invite — issuing a staff member's single-use enrolment link, which grants sign-in to the organisation's data. Admin only; the holder never sees the person's password or authenticator (0129).

INSERT INTO nzi_console.staff_capability_matrix_versions (matrix_version, source, note)
VALUES (8, 'docs/PERMISSION_MATRIX.md', 'Adds staff.invite — issuing a staff member''s single-use enrolment link, which grants sign-in to the organisation''s data. Admin only; the holder never sees the person''s password or authenticator (0129).');

INSERT INTO nzi_console.staff_role_capabilities (matrix_version, role_id, capability, scope) VALUES
  (8, 'admin', 'client.view', 'all'),
  (8, 'admin', 'client.create', 'all'),
  (8, 'admin', 'client.edit', 'all'),
  (8, 'admin', 'client.deactivate', 'all'),
  (8, 'admin', 'contact.manage', 'all'),
  (8, 'admin', 'site.manage', 'all'),
  (8, 'admin', 'target.edit', 'all'),
  (8, 'admin', 'baseline.rebaseline', 'all'),
  (8, 'admin', 'job.manage', 'all'),
  (8, 'admin', 'scoperow.edit', 'all'),
  (8, 'admin', 'snapshot.review', 'all'),
  (8, 'admin', 'report.edit', 'all'),
  (8, 'admin', 'report.publish', 'all'),
  (8, 'admin', 'report.view', 'all'),
  (8, 'admin', 'strategy.manage', 'all'),
  (8, 'admin', 'srs.manage', 'all'),
  (8, 'admin', 'training.manage', 'all'),
  (8, 'admin', 'training.entitlement.manage', 'all'),
  (8, 'admin', 'finance.view', 'all'),
  (8, 'admin', 'finance.manage', 'all'),
  (8, 'admin', 'portal.admin', 'all'),
  (8, 'admin', 'category.visibility', 'all'),
  (8, 'admin', 'subject.review', 'all'),
  (8, 'admin', 'subject.export', 'all'),
  (8, 'admin', 'subject.erase', 'all'),
  (8, 'admin', 'clientfactor.manage', 'all'),
  (8, 'admin', 'dataset.manage', 'all'),
  (8, 'admin', 'factor.manage', 'all'),
  (8, 'admin', 'admin.users', 'all'),
  (8, 'admin', 'staff.invite', 'all'),
  (8, 'admin', 'admin.lookups', 'all'),
  (8, 'admin', 'admin.templates', 'all'),
  (8, 'admin', 'admin.settings', 'all'),
  (8, 'admin', 'audit.view', 'all'),
  (8, 'admin', 'support.portal_impersonate', 'all'),
  (8, 'admin', 'knowledge.capture', 'all'),
  (8, 'admin', 'knowledge.approve', 'all'),
  (8, 'admin', 'knowledge.publish', 'all'),
  (8, 'consultant', 'client.view', 'all'),
  (8, 'consultant', 'client.create', 'all'),
  (8, 'consultant', 'client.edit', 'all'),
  (8, 'consultant', 'contact.manage', 'all'),
  (8, 'consultant', 'site.manage', 'all'),
  (8, 'consultant', 'target.edit', 'all'),
  (8, 'consultant', 'job.manage', 'all'),
  (8, 'consultant', 'scoperow.edit', 'all'),
  (8, 'consultant', 'report.edit', 'all'),
  (8, 'consultant', 'report.view', 'all'),
  (8, 'consultant', 'strategy.manage', 'all'),
  (8, 'consultant', 'srs.manage', 'all'),
  (8, 'consultant', 'training.manage', 'all'),
  (8, 'consultant', 'training.entitlement.manage', 'all'),
  (8, 'consultant', 'finance.view', 'all'),
  (8, 'consultant', 'clientfactor.manage', 'all'),
  (8, 'consultant', 'support.portal_impersonate', 'all'),
  (8, 'consultant', 'knowledge.capture', 'all'),
  (8, 'consultant', 'knowledge.approve', 'all'),
  (8, 'consultant', 'baseline.rebaseline', 'own_clients'),
  (8, 'consultant', 'portal.admin', 'own_clients'),
  (8, 'consultant', 'category.visibility', 'own_clients'),
  (8, 'consultant', 'audit.view', 'own_clients'),
  (8, 'reviewer', 'client.view', 'all'),
  (8, 'reviewer', 'snapshot.review', 'all'),
  (8, 'reviewer', 'report.publish', 'all'),
  (8, 'reviewer', 'report.view', 'all'),
  (8, 'reviewer', 'audit.view', 'all'),
  (8, 'reviewer', 'knowledge.capture', 'all'),
  (8, 'finance', 'client.view', 'all'),
  (8, 'finance', 'report.view', 'all'),
  (8, 'finance', 'finance.view', 'all'),
  (8, 'finance', 'finance.manage', 'all'),
  (8, 'finance', 'knowledge.capture', 'all'),
  (8, 'finance', 'audit.view', 'own_clients'),
  (8, 'viewer', 'client.view', 'all'),
  (8, 'viewer', 'report.view', 'all'),
  (8, 'viewer', 'knowledge.capture', 'all');

COMMIT;
