BEGIN;

-- R2 (NZC-048) — editable report sections. A CRP report is an ordered list of
-- versioned narrative sections. The *default* wording is the NZI template, held
-- in code (@nzi/contracts crpReportSectionCatalogue), so a working row exists
-- here only once a section has been edited or explicitly reset. `version` plus an
-- append-only history mirror job_scope_rows; the section text is frozen into the
-- reviewed snapshot payload at report.snapshot.create.

CREATE TABLE nzi_console.report_sections (
  organisation_id text NOT NULL,
  job_id text NOT NULL,
  section_key text NOT NULL,
  content_source text NOT NULL CHECK (content_source IN ('default','ai','client-edited')),
  body_html text NOT NULL CHECK (nullif(trim(body_html),'') IS NOT NULL),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, job_id, section_key),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id)
);

CREATE TABLE nzi_console.report_section_versions (
  organisation_id text NOT NULL,
  section_version_id text NOT NULL,
  job_id text NOT NULL,
  section_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  content_source text NOT NULL CHECK (content_source IN ('default','ai','client-edited')),
  body_html text NOT NULL,
  actor_id text NOT NULL,
  note text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, section_version_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id),
  UNIQUE (organisation_id, job_id, section_key, version)
);

ALTER TABLE nzi_console.report_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.report_sections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.report_sections
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.report_sections TO nzi_console_app;
REVOKE DELETE ON nzi_console.report_sections FROM nzi_console_app;

ALTER TABLE nzi_console.report_section_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.report_section_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.report_section_versions
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT ON nzi_console.report_section_versions TO nzi_console_app;
REVOKE UPDATE, DELETE ON nzi_console.report_section_versions FROM nzi_console_app;

COMMENT ON TABLE nzi_console.report_sections IS
  'R2/NZC-048 working editable report narrative sections; default wording lives in code, a row exists only once edited or reset.';
COMMENT ON TABLE nzi_console.report_section_versions IS
  'Append-only history of every report-section text version (who, when, source), recoverable like a scope row.';

COMMIT;
