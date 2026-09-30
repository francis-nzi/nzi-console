-- 0140 The milestone command (PR 3; ruled plan `pr3-milestone-command-plan.md` §2, M2, M3, M9 and ruled fix 1).
--
-- ## What it adds to `job_milestones` (0137)
--
-- 1. **`due_source`** — where a milestone's date came from: `template` (generated from a milestone template, at
--    job creation or by reschedule), `manual` (set by hand, or a completion recorded with no date), or `import` (v7's
--    job plan, loaded by the PR 2 backfill). The 1,022 rows that exist today are all `import`. No default: every writer
--    names its source. Reschedule moves only `template` rows that are not completed (Q11); `manual` and `import` rows
--    never move — this column is the per-milestone override (Q10).
-- 2. **`template_id`** — which template a `template` row belongs to. Held only by `template` rows, and by every one of
--    them — including a row whose kind the job's template no longer schedules, which reschedule clears but keeps
--    (M3): its `template_id` marks whose empty slot it is.
-- 3. **`due_basis`** (M9) — what a template date was computed from, captured when it was generated: the template and
--    its version, the item's label, the anchor and which date it came from, the offset. The job page's lineage reads
--    this, not the template as it is now, so it stays true after a template or a job's dates change. Held exactly
--    when a `template` row has a date (ruled fix 1): a cleared template row has neither.
--
-- ## What it amends
--
-- 0137's `job_milestones_records_something` required a date, a completion or a v7 identity, which forbids the three
-- things the commands must do without deleting (no DELETE, by ruling): clear a date, reopen an undated completion, and
-- clear a kind a new template drops. It is replaced (M2): a row records a date, a completion or a v7 identity — **or**
-- is a console row (`manual` or `template`) deliberately left empty. The Risk rule already ignores an undated
-- milestone, so an empty row reads as that kind "not set". An imported row still always carries its v7 identity.
--
-- Grants are unchanged (SELECT, INSERT, UPDATE; no DELETE); row-level security is 0137's.

BEGIN;

ALTER TABLE nzi_console.job_milestones
  ADD COLUMN due_source text,
  ADD COLUMN template_id text,
  ADD COLUMN due_basis jsonb;

-- Every milestone that exists today was loaded from v7's job plan by the PR 2 backfill.
UPDATE nzi_console.job_milestones SET due_source = 'import';

ALTER TABLE nzi_console.job_milestones
  ALTER COLUMN due_source SET NOT NULL,
  ADD CONSTRAINT job_milestones_due_source_check CHECK (due_source IN ('template', 'manual', 'import')),
  ADD CONSTRAINT job_milestones_template_fk
    FOREIGN KEY (organisation_id, template_id) REFERENCES nzi_console.milestone_templates (organisation_id, template_id),
  -- A template row always names its template (even once cleared); no other row does.
  ADD CONSTRAINT job_milestones_template_id_shape CHECK ((due_source = 'template') = (template_id IS NOT NULL)),
  -- Ruled fix 1: the basis a date was computed from, exactly when a template row has a date.
  ADD CONSTRAINT job_milestones_due_basis_shape CHECK ((due_source = 'template' AND due_date IS NOT NULL) = (due_basis IS NOT NULL)),
  DROP CONSTRAINT job_milestones_records_something,
  -- M2: a stored milestone records something — or is a console row deliberately left empty (a date cleared, an
  -- undated completion reopened, a kind a new template dropped). An imported row always carries its v7 identity.
  ADD CONSTRAINT job_milestones_records_something CHECK (
    due_date IS NOT NULL OR completed_at IS NOT NULL OR source_system IS NOT NULL OR due_source IN ('manual', 'template'));

CREATE INDEX job_milestones_template_idx ON nzi_console.job_milestones (organisation_id, template_id) WHERE template_id IS NOT NULL;

COMMENT ON COLUMN nzi_console.job_milestones.due_source IS
  'Where the date came from: template (generated), manual (set by hand), import (v7''s job plan). Reschedule moves only uncompleted template rows (Q10, Q11).';
COMMENT ON COLUMN nzi_console.job_milestones.due_basis IS
  'For a dated template row: {templateId, templateVersion, itemLabel, anchor, anchorFrom, daysOffset} as generated — the lineage the job page shows (M9).';

COMMIT;
