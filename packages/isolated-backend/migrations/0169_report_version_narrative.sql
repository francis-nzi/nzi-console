-- 0169 A report version's frozen narrative (RULING-report-studio-B2-4; numbered 0168 there, renumbered because the self-approval
-- fix (#486) took 0168 — the shape is unchanged).
--
-- B2-4 makes the report's narrative editable and frozen. `report.validate` writes the narrative the version will issue — the job's
-- working sections (`report_sections`, else the catalogue template), for each narrative section the version's plan draws — onto the
-- version, here. The B0 preview and publish compose from this frozen copy, so what was validated is exactly what is issued, and
-- `composed@6` draws it with its tokens resolved from the frozen composition.
--
--   * Each element `{ key, bodyHtml, contentSource, sectionVersion }`, one per drawn narrative section, in catalogue order. A body
--     holds token keys (`<span data-token="…">`), never a typed figure (the command refuses one), and never money (NZC-120).
--   * NULL means "validated before B2-4": such a version composes, previews and publishes as `composed@5`, with the template, as
--     today. No backfill. Published, superseded and withdrawn rows and every frozen composition are untouched.
--   * Additive only: no request-time DDL, RLS and grants unchanged (0002's table grant covers the new column). The runner wraps
--     this in its transaction.

ALTER TABLE nzi_console.report_versions
  ADD COLUMN narrative jsonb NULL,
  ADD CONSTRAINT report_versions_narrative_array CHECK (narrative IS NULL OR jsonb_typeof(narrative) = 'array');

COMMENT ON COLUMN nzi_console.report_versions.narrative IS
  'B2-4: the narrative frozen at validate — [{key, bodyHtml, contentSource, sectionVersion}] per drawn narrative section, token keys only. NULL = validated before B2-4 (composed@5, template).';
