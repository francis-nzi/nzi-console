BEGIN;

ALTER TABLE nzi_console.memberships
  ADD CONSTRAINT memberships_role_id_check CHECK (role_id IN (
    'administrator', 'consultant', 'reviewer', 'finance', 'methodology-data-admin', 'read-only'
  ));

COMMIT;
