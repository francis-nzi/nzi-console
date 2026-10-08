BEGIN;

-- Redesign Phase 3b (ruled 8 Oct 2026: JOB-REDESIGN-phase3-kickoff.md §3b, RULING-phase3-design.md #7–#11) — which
-- version of the client's reporting template seeded this job's entry rows.
--
-- `job.seedFromTemplate` (and the auto-seed on CRP job create) creates a job's scope rows from the client's active
-- reporting template (`client_reporting_templates`, 0159), and records here the version it read, so last year's job and
-- this year's can honestly cite different template versions.
--
-- On `job_emissions_config`, the per-job config row: the table is already mutable (the app holds UPDATE; `job.update`
-- moves the window), so a re-seed overwrites these two columns with the version it read — each seed's own audit event
-- keeps the history. Nullable and additive: a job never seeded reads NULL, and every existing row is untouched (no
-- backfill). No foreign key to the template: the config row carries no client_id, and the template's key is
-- (organisation, client, version); the command reads the version from the template it seeds from.
--
-- Not period-bound data: `job.update` classifies this table as "the window itself" (J2), so the columns change nothing
-- for its period check.

ALTER TABLE nzi_console.job_emissions_config
  ADD COLUMN seeded_template_version integer CHECK (seeded_template_version > 0),
  ADD COLUMN seeded_at timestamptz,
  -- Both or neither: a version without its moment, or a moment without a version, is not a seed.
  ADD CONSTRAINT job_emissions_config_seeded_pair CHECK ((seeded_template_version IS NULL) = (seeded_at IS NULL));

COMMIT;
