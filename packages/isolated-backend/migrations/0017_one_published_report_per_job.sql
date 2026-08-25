BEGIN;
CREATE UNIQUE INDEX report_version_one_published_per_job
  ON nzi_console.report_versions(organisation_id,job_id)
  WHERE status='published';
COMMIT;
