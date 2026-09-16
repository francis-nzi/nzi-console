BEGIN;

-- Permission matrix version 4.
--
-- Generated from ROLE_CAPABILITY_MATRIX by scripts/generate-matrix.ts, so the migration and
-- the code copy cannot disagree by transcription. A test holds them equal.
--
-- The matrix is migration-owned and versioned, so this is a NEW version rather than an edit
-- of the last one: a principal resolved against an earlier version keeps meaning what it
-- meant when it was resolved.
--
-- v4 — knowledge library capabilities (NZC-081): knowledge.capture for every role, knowledge.approve for Admin and Consultant, knowledge.publish for Admin only

INSERT INTO nzi_console.staff_capability_matrix_versions (matrix_version, source, note)
VALUES (4, 'docs/PERMISSION_MATRIX.md', 'v4 — knowledge library capabilities (NZC-081): knowledge.capture for every role, knowledge.approve for Admin and Consultant, knowledge.publish for Admin only');

INSERT INTO nzi_console.staff_role_capabilities (matrix_version, role_id, capability, scope) VALUES
  (4, 'admin', 'client.view', 'all'),
  (4, 'admin', 'client.create', 'all'),
  (4, 'admin', 'client.edit', 'all'),
  (4, 'admin', 'client.deactivate', 'all'),
  (4, 'admin', 'contact.manage', 'all'),
  (4, 'admin', 'site.manage', 'all'),
  (4, 'admin', 'target.edit', 'all'),
  (4, 'admin', 'baseline.rebaseline', 'all'),
  (4, 'admin', 'job.manage', 'all'),
  (4, 'admin', 'scoperow.edit', 'all'),
  (4, 'admin', 'snapshot.review', 'all'),
  (4, 'admin', 'report.edit', 'all'),
  (4, 'admin', 'report.publish', 'all'),
  (4, 'admin', 'report.view', 'all'),
  (4, 'admin', 'strategy.manage', 'all'),
  (4, 'admin', 'srs.manage', 'all'),
  (4, 'admin', 'training.manage', 'all'),
  (4, 'admin', 'training.entitlement.manage', 'all'),
  (4, 'admin', 'finance.view', 'all'),
  (4, 'admin', 'finance.manage', 'all'),
  (4, 'admin', 'portal.admin', 'all'),
  (4, 'admin', 'clientfactor.manage', 'all'),
  (4, 'admin', 'dataset.manage', 'all'),
  (4, 'admin', 'factor.manage', 'all'),
  (4, 'admin', 'admin.users', 'all'),
  (4, 'admin', 'admin.lookups', 'all'),
  (4, 'admin', 'admin.templates', 'all'),
  (4, 'admin', 'admin.settings', 'all'),
  (4, 'admin', 'audit.view', 'all'),
  (4, 'admin', 'support.portal_impersonate', 'all'),
  (4, 'admin', 'knowledge.capture', 'all'),
  (4, 'admin', 'knowledge.approve', 'all'),
  (4, 'admin', 'knowledge.publish', 'all'),
  (4, 'consultant', 'client.view', 'all'),
  (4, 'consultant', 'client.create', 'all'),
  (4, 'consultant', 'client.edit', 'all'),
  (4, 'consultant', 'contact.manage', 'all'),
  (4, 'consultant', 'site.manage', 'all'),
  (4, 'consultant', 'target.edit', 'all'),
  (4, 'consultant', 'job.manage', 'all'),
  (4, 'consultant', 'scoperow.edit', 'all'),
  (4, 'consultant', 'report.edit', 'all'),
  (4, 'consultant', 'report.view', 'all'),
  (4, 'consultant', 'strategy.manage', 'all'),
  (4, 'consultant', 'srs.manage', 'all'),
  (4, 'consultant', 'training.manage', 'all'),
  (4, 'consultant', 'training.entitlement.manage', 'all'),
  (4, 'consultant', 'finance.view', 'all'),
  (4, 'consultant', 'clientfactor.manage', 'all'),
  (4, 'consultant', 'support.portal_impersonate', 'all'),
  (4, 'consultant', 'knowledge.capture', 'all'),
  (4, 'consultant', 'knowledge.approve', 'all'),
  (4, 'consultant', 'baseline.rebaseline', 'own_clients'),
  (4, 'consultant', 'portal.admin', 'own_clients'),
  (4, 'consultant', 'audit.view', 'own_clients'),
  (4, 'reviewer', 'client.view', 'all'),
  (4, 'reviewer', 'snapshot.review', 'all'),
  (4, 'reviewer', 'report.publish', 'all'),
  (4, 'reviewer', 'report.view', 'all'),
  (4, 'reviewer', 'audit.view', 'all'),
  (4, 'reviewer', 'knowledge.capture', 'all'),
  (4, 'finance', 'client.view', 'all'),
  (4, 'finance', 'report.view', 'all'),
  (4, 'finance', 'finance.view', 'all'),
  (4, 'finance', 'finance.manage', 'all'),
  (4, 'finance', 'knowledge.capture', 'all'),
  (4, 'finance', 'audit.view', 'own_clients'),
  (4, 'viewer', 'client.view', 'all'),
  (4, 'viewer', 'report.view', 'all'),
  (4, 'viewer', 'knowledge.capture', 'all');

COMMIT;
