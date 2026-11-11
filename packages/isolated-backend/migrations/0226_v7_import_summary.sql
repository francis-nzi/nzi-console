-- 0226 The import workbench, Phase 1: a job's reconciliation summary, stored to be seen (BRIEF-v7-import-workbench-phase1).
--
-- ## Why
--
-- The v7 import has an engine (re-sync 0225, re-ingest + D7, the rehearsal) but no operator surface: every refusal dead-ends
-- in a shell. Phase 1 lets the team see each job's import state. Diff-at-the-edge (provisional R-A): the one-job extract is
-- read on the operator's machine, and only a non-PII reconciliation summary — per v7 row its import identity, status, factor
-- code, scope, figure on each side and pair link — is uploaded here. The extract itself never reaches the service.
--
-- ## What it adds
--
--   - `v7_import_sessions`: one per uploaded summary of a job — the extract it was made from, who uploaded it and when, the
--     counts per status, Σ per scope (console against v7) and the verdict. The same summary is stored once.
--   - `v7_import_rows`: the summary's rows. Every column is an id, a code of a fixed shape, a status, a boolean or a tCO2e
--     figure — no label, name, quantity or free text has a column to land in, and each shape is a CHECK.
--
-- Both are disposable but never silently editable: SELECT and INSERT for the app, no UPDATE, no DELETE (a purge, when it
-- comes, is its own migration). Nothing here touches a job's rows: Phase 1 only stores and shows.

BEGIN;

CREATE TABLE nzi_console.v7_import_sessions (
  organisation_id text NOT NULL,
  session_id text NOT NULL CHECK (session_id ~ '^v7-import-[0-9a-f-]{36}$'),
  job_id text NOT NULL,
  legacy_job_number text NOT NULL CHECK (legacy_job_number ~ '^J[0-9]{6}$'),
  extract_sha256 text NOT NULL CHECK (extract_sha256 ~ '^[0-9a-f]{64}$'),
  summary_sha256 text NOT NULL CHECK (summary_sha256 ~ '^[0-9a-f]{64}$'),
  generated_at timestamptz NOT NULL,
  rows_matched integer NOT NULL CHECK (rows_matched >= 0),
  rows_changed integer NOT NULL CHECK (rows_changed >= 0),
  rows_needs_mapping integer NOT NULL CHECK (rows_needs_mapping >= 0),
  rows_new integer NOT NULL CHECK (rows_new >= 0),
  rows_withdrawn integer NOT NULL CHECK (rows_withdrawn >= 0),
  rows_linked_pair_changed integer NOT NULL CHECK (rows_linked_pair_changed >= 0),
  -- Σ per scope, each side: the only tCO2e besides the per-row figures.
  console_scope1_tco2e numeric NOT NULL, console_scope2_tco2e numeric NOT NULL, console_scope3_tco2e numeric NOT NULL,
  v7_scope1_tco2e numeric NOT NULL, v7_scope2_tco2e numeric NOT NULL, v7_scope3_tco2e numeric NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('clean', 'needs-mapping', 'blocked-on-pairs')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text NOT NULL,
  PRIMARY KEY (organisation_id, session_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id),
  CONSTRAINT v7_import_sessions_has_rows CHECK (
    rows_matched + rows_changed + rows_needs_mapping + rows_new + rows_withdrawn + rows_linked_pair_changed > 0)
);
CREATE UNIQUE INDEX v7_import_sessions_summary_once_idx ON nzi_console.v7_import_sessions (organisation_id, job_id, summary_sha256);
CREATE INDEX v7_import_sessions_job_latest_idx ON nzi_console.v7_import_sessions (organisation_id, job_id, created_at DESC);

COMMENT ON TABLE nzi_console.v7_import_sessions IS
  'One uploaded import reconciliation summary of one job (0226, import workbench Phase 1): the extract it came from, counts per status, Σ per scope and the verdict. Read-only once written; it changes nothing on the job.';

CREATE TABLE nzi_console.v7_import_rows (
  organisation_id text NOT NULL,
  session_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  source_system text NOT NULL CHECK (source_system = 'nzi-pro-v7'),
  legacy_db_id text NOT NULL CHECK (legacy_db_id ~ '^(source:)?[0-9A-Za-z_-]{1,64}$'),
  status text NOT NULL CHECK (status IN ('matched', 'changed', 'needs-mapping', 'new', 'withdrawn', 'linked-pair-changed')),
  code text CHECK (code IS NULL OR code ~ '^[0-9A-Za-z_.:-]{1,64}$'),
  scope text NOT NULL CHECK (scope IN ('1', '2', '3')),
  console_scope text CHECK (console_scope IS NULL OR console_scope IN ('1', '2', '3')),
  v7_tco2e numeric,
  console_tco2e numeric,
  v7_enabled boolean,
  console_enabled boolean,
  console_row_id text CHECK (console_row_id IS NULL OR console_row_id ~ '^v7-(row|source)-[0-9A-Za-z_-]{1,80}$'),
  pair_ref text CHECK (pair_ref IS NULL OR pair_ref ~ '^v7-(row|source)-[0-9A-Za-z_-]{1,80}$'),
  -- Compared column names only (the loader's), never a value.
  changed_fields text[] NOT NULL DEFAULT '{}' CHECK (changed_fields <@ ARRAY[
    'job_id', 'scope', 'source_label', 'report_label', 'level_1', 'level_2', 'level_3', 'level_4', 'column_text', 'quantity', 'unit',
    'dataset_id', 'factor_id', 'calculated_tco2e', 'review_status', 'enabled', 'apply_pct', 'data_confidence', 'site_id',
    'is_auto_generated', 'auto_pair_kind', 'linked_row_id', 'provenance_json', 'lineage_json', 'origin', 'migrated_record',
    'migrated_record.uom', 'migrated_record.dataset', 'migrated_record.factor_db_id', 'migrated_record.original_id',
    'migrated_record.ghg_unit', 'migrated_record.factor']::text[]),
  PRIMARY KEY (organisation_id, session_id, legacy_db_id),
  UNIQUE (organisation_id, session_id, ordinal),
  FOREIGN KEY (organisation_id, session_id) REFERENCES nzi_console.v7_import_sessions(organisation_id, session_id),
  -- Each side is whole or absent, and the status says which sides there are.
  CONSTRAINT v7_import_rows_v7_side CHECK ((v7_tco2e IS NULL) = (v7_enabled IS NULL) AND (v7_tco2e IS NOT NULL OR code IS NULL)),
  CONSTRAINT v7_import_rows_console_side CHECK (
    (console_tco2e IS NULL) = (console_enabled IS NULL) AND (console_tco2e IS NULL) = (console_row_id IS NULL)
    AND (console_tco2e IS NULL) = (console_scope IS NULL)),
  CONSTRAINT v7_import_rows_status_shape CHECK (CASE status
    WHEN 'matched' THEN v7_tco2e IS NOT NULL AND console_tco2e IS NOT NULL AND cardinality(changed_fields) = 0
    WHEN 'changed' THEN v7_tco2e IS NOT NULL AND console_tco2e IS NOT NULL AND cardinality(changed_fields) > 0
    WHEN 'needs-mapping' THEN v7_tco2e IS NOT NULL AND console_tco2e IS NOT NULL AND cardinality(changed_fields) > 0
    WHEN 'new' THEN v7_tco2e IS NOT NULL AND console_tco2e IS NULL
    WHEN 'withdrawn' THEN v7_tco2e IS NULL AND console_tco2e IS NOT NULL AND console_enabled
    ELSE (v7_tco2e IS NOT NULL OR console_tco2e IS NOT NULL) AND pair_ref IS NOT NULL END)
);

COMMENT ON TABLE nzi_console.v7_import_rows IS
  'The rows of an import reconciliation summary (0226): per v7 record its import identity, status, factor code, scope, tCO2e on each side and pair link. No label, name, quantity or free text; read-only once written.';

ALTER TABLE nzi_console.v7_import_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.v7_import_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.v7_import_sessions
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
ALTER TABLE nzi_console.v7_import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.v7_import_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.v7_import_rows
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

-- Written once, read after. Never updated, never deleted.
GRANT SELECT, INSERT ON nzi_console.v7_import_sessions, nzi_console.v7_import_rows TO nzi_console_app;
REVOKE UPDATE, DELETE, TRUNCATE ON nzi_console.v7_import_sessions, nzi_console.v7_import_rows FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

COMMIT;
