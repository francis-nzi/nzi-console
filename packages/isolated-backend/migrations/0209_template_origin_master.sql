-- A client's data entry template may now begin from a master template (0197): a fourth origin, `master`, whose
-- origin_ref names the master and the rows version it was read at (`<master_id>@<rows_version>`).
-- The origin_ref CHECK (0159: ref present exactly when origin is not `manual`) already holds for it. Nothing else changes.
ALTER TABLE nzi_console.client_reporting_templates DROP CONSTRAINT client_reporting_templates_origin_check;
ALTER TABLE nzi_console.client_reporting_templates
  ADD CONSTRAINT client_reporting_templates_origin_check CHECK (origin IN ('manual', 'job', 'v7-import', 'master'));
