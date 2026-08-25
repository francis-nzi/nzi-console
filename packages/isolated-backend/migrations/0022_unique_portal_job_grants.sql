BEGIN;

ALTER TABLE nzi_console.portal_access_grants
  ADD CONSTRAINT portal_access_grants_user_job_unique
  UNIQUE (organisation_id,portal_user_id,job_id);

COMMIT;
