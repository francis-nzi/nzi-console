BEGIN;

-- Redesign Phase 1c (ruled, JOB-WORKFLOW-rulings-round2.md item 3; design note JOB-REDESIGN-phase1-design-note.md §1c) —
-- the client's reporting template: what a client reports, year to year, held on the Client rather than rebuilt on every
-- job. Scopes → categories → lines, each line the activity a job captures (its source and report labels, and where it is
-- known its site, its usual dataset and factor, and its unit). Quantities never live here — the job records the year.
--
-- A version is the whole template, as `client_targets` (0069) versions are: changing the template writes the next
-- version, header and lines together; the one before stays readable; the current is the highest version. A job records
-- which version seeded it (Phase 3), so last year's job and this year's can differ honestly. Withdrawing writes a version
-- with `active = false`, a reason and no lines.
--
-- A line's `category_code` is an input-spec category, or NULL: a line initialised from v7's history carries no category
-- (v7's rows have none, JW-10), and it is shown as "to file" — never guessed.

CREATE TABLE nzi_console.client_reporting_templates (
  organisation_id text NOT NULL,
  client_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),

  -- Deactivate, never delete: the template is withdrawn by a version that says so.
  active boolean NOT NULL DEFAULT true,
  -- Where this version came from: typed (`manual`), built from a job's console rows (`job`), or from a job's imported v7
  -- history (`v7-import`). The two derived origins name the job they were built from.
  origin text NOT NULL CHECK (origin IN ('manual', 'job', 'v7-import')),
  origin_ref text CHECK (origin_ref IS NULL OR btrim(origin_ref) <> ''),
  /* Why this version exists — required to withdraw. */
  reason text CHECK (reason IS NULL OR (reason = trim(reason) AND reason <> '')),
  set_by text NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text NOT NULL,

  PRIMARY KEY (organisation_id, client_id, version),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id),
  CONSTRAINT client_reporting_templates_origin_ref CHECK ((origin = 'manual') = (origin_ref IS NULL)),
  -- A withdrawal says why.
  CONSTRAINT client_reporting_templates_deactivation_reason CHECK (active OR reason IS NOT NULL)
);
CREATE INDEX client_reporting_templates_current_idx ON nzi_console.client_reporting_templates (organisation_id, client_id, version DESC);

CREATE TABLE nzi_console.client_reporting_template_lines (
  organisation_id text NOT NULL,
  client_id text NOT NULL,
  version integer NOT NULL,
  line_id text NOT NULL CHECK (btrim(line_id) <> ''),

  scope text NOT NULL CHECK (scope IN ('1', '2', '3')),
  -- An input-spec category of the same scope, or NULL for a line still "to file".
  category_code text REFERENCES nzi_console.input_spec_categories(category_code),
  source_label text NOT NULL CHECK (btrim(source_label) <> ''),
  report_label text CHECK (report_label IS NULL OR btrim(report_label) <> ''),
  site_id text,
  -- The line's usual factor, if it has one; the job's datasets decide what is offered (Phase 3 re-checks on seeding).
  dataset_id text,
  factor_id text,
  unit text CHECK (unit IS NULL OR btrim(unit) <> ''),
  ordering integer NOT NULL CHECK (ordering >= 0),

  PRIMARY KEY (organisation_id, client_id, version, line_id),
  FOREIGN KEY (organisation_id, client_id, version) REFERENCES nzi_console.client_reporting_templates(organisation_id, client_id, version),
  FOREIGN KEY (organisation_id, site_id) REFERENCES nzi_console.client_sites(organisation_id, site_id),
  -- One vocabulary: a category belongs to one scope, and the line says the same scope.
  CONSTRAINT client_reporting_template_lines_category_scope CHECK (category_code IS NULL OR split_part(category_code, '.', 1) = scope),
  -- A factor is named within its dataset.
  CONSTRAINT client_reporting_template_lines_factor_dataset CHECK (factor_id IS NULL OR dataset_id IS NOT NULL)
);
CREATE INDEX client_reporting_template_lines_version_idx ON nzi_console.client_reporting_template_lines (organisation_id, client_id, version, ordering);

ALTER TABLE nzi_console.client_reporting_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_reporting_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_reporting_templates
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
ALTER TABLE nzi_console.client_reporting_template_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_reporting_template_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_reporting_template_lines
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
-- Append-only: a change is a new version, never an edit of the one before it.
GRANT SELECT, INSERT ON nzi_console.client_reporting_templates TO nzi_console_app;
GRANT SELECT, INSERT ON nzi_console.client_reporting_template_lines TO nzi_console_app;
REVOKE UPDATE, DELETE ON nzi_console.client_reporting_templates FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;
REVOKE UPDATE, DELETE ON nzi_console.client_reporting_template_lines FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

COMMIT;
