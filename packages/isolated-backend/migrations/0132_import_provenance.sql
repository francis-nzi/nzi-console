-- 0132 Where an imported client, site, contact, job, emissions row or client factor came from
-- (docs/CLIENT_JOB_IMPORT_DESIGN.md §4, ruled 27–28 Sep 2026).
--
-- ## Why
--
-- The v7 client and job import brings active clients and their full job history into net-zero-international. Every
-- imported row must say what it was in v7 and be found again on a re-run — the same identity the factor import
-- gave emission factors (0126): `source_system` and `legacy_db_id`, keyed per organisation. Until now only the
-- three factor tables carried them.
--
-- ## What it adds
--
-- On `clients`, `client_sites`, `client_contacts`, `jobs`, `job_scope_rows` and `client_factors`:
--
--   - `source_system text` — which system the row came from (`nzi-pro-v7`), or NULL for a row made here;
--   - `legacy_db_id text` — that system's primary key for it, as text;
--   - a partial unique key `(organisation_id, source_system, legacy_db_id)` where `source_system` is set, so a
--     re-run lands on the same rows and one v7 row can never become two;
--   - a CHECK that an imported row names its v7 id, and a row made here names neither.
--
-- On `jobs`, v7's human identifiers kept verbatim beside it: `legacy_job_number` (v7's J-number, as v7 wrote it)
-- and `legacy_wfm_job_no` (the WorkflowMax number v7 itself carried from its own earlier import).
--
-- ## What it does not do
--
-- Load anything: every row that exists today has `source_system` NULL, which is what a row made here is. Register
-- tables are untouched — every migrated figure becomes a `job_scope_rows` row (§6.1).

BEGIN;

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['clients', 'client_sites', 'client_contacts', 'jobs', 'job_scope_rows', 'client_factors'] LOOP
    EXECUTE format('ALTER TABLE nzi_console.%I ADD COLUMN source_system text, ADD COLUMN legacy_db_id text', target);
    EXECUTE format(
      'ALTER TABLE nzi_console.%I ADD CONSTRAINT %I CHECK ('
      || '(source_system IS NULL AND legacy_db_id IS NULL) '
      || 'OR (source_system IS NOT NULL AND btrim(source_system) <> '''' AND legacy_db_id IS NOT NULL AND btrim(legacy_db_id) <> ''''))',
      target, target || '_import_provenance_shape');
    EXECUTE format(
      'CREATE UNIQUE INDEX %I ON nzi_console.%I (organisation_id, source_system, legacy_db_id) WHERE source_system IS NOT NULL',
      target || '_import_identity_key', target);
    EXECUTE format('COMMENT ON COLUMN nzi_console.%I.legacy_db_id IS %L', target,
      'The primary key of this row in source_system (v7: its integer id, as text). With source_system and the organisation, the import identity key: a re-run lands on this row.');
  END LOOP;
END $$;

ALTER TABLE nzi_console.jobs
  ADD COLUMN legacy_job_number text,
  ADD COLUMN legacy_wfm_job_no text,
  ADD CONSTRAINT jobs_legacy_numbers_are_imported CHECK (
    (legacy_job_number IS NULL AND legacy_wfm_job_no IS NULL) OR source_system IS NOT NULL
  );

COMMENT ON COLUMN nzi_console.jobs.legacy_job_number IS
  'The job number exactly as v7 wrote it. Kept beside the console''s own number, which for an imported job is v7''s (decision 1a).';
COMMENT ON COLUMN nzi_console.jobs.legacy_wfm_job_no IS
  'The WorkflowMax job number v7 carried from its own earlier import, verbatim.';

COMMIT;
