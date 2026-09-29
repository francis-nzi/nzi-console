-- 0137 A job's three delivery milestones — what the Risk traffic light reads (docs/LIST_PARITY_DESIGN.md, PR 2).
--
-- ## Why
--
-- Risk (Overdue / Due / Healthy / Not set) is derived from a job's milestones: data collection, first draft and
-- final report, each with a due date and a completion. v7 keeps them on `job_plan`, one row per job with three column
-- pairs; the first v7 import did not extract it (it was not among the fifteen tables), so every imported job would
-- read "Not set". This is the table the backfill fills, and the rule reads (src/milestoneRisk.ts).
--
-- ## An operational table, not history
--
-- Unlike the imported clients and jobs, a milestone changes: its completion is ticked, its date moves. The console
-- will write it (PR 3, the milestone command), so the application role may INSERT and UPDATE. No role may DELETE —
-- a milestone is cleared, not removed. A backfilled row carries its v7 identity (`source_system`, `legacy_db_id`) and
-- the v7 values it was last loaded with (`legacy_values`), so a later backfill can tell "v7 changed" from "the console
-- changed it" and never overwrites a console edit (ruled R3).
--
-- ## One row per kind that has anything recorded
--
-- A kind with neither a due date nor a completion is not stored. A kind with a completion but no due date is stored
-- (it happened) and is ignored by the Risk rule, as v7 ignores it.
--
-- ## Who completed it
--
-- `completed_by_label` is the name v7 recorded, verbatim — staff, not client data, unsealed by ruling (R4) and listed
-- in the PII inventory. `completed_by_user_id` is set only on an exact, unique match to a membership; it is an id.

BEGIN;

CREATE TABLE nzi_console.job_milestones (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  job_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('data_collection', 'first_draft', 'final_report')),
  due_date date,
  completed_at timestamptz,
  completed_by_user_id text,
  completed_by_label text CHECK (completed_by_label IS NULL OR btrim(completed_by_label) <> ''),

  source_system text,
  legacy_db_id text,
  legacy_values jsonb,

  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),

  PRIMARY KEY (organisation_id, job_id, kind),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs (organisation_id, job_id),

  -- Who completed a milestone is only meaningful once it is completed.
  CONSTRAINT job_milestones_completed_by_needs_completion
    CHECK (completed_at IS NOT NULL OR (completed_by_user_id IS NULL AND completed_by_label IS NULL)),
  -- The import-provenance shape of 0132: an imported row names its v7 id; a row made here names neither.
  CONSTRAINT job_milestones_import_provenance_shape CHECK (
    (source_system IS NULL AND legacy_db_id IS NULL AND legacy_values IS NULL)
    OR (source_system IS NOT NULL AND btrim(source_system) <> '' AND legacy_db_id IS NOT NULL AND btrim(legacy_db_id) <> ''
        AND legacy_values IS NOT NULL)),
  -- A stored milestone records something.
  CONSTRAINT job_milestones_records_something CHECK (due_date IS NOT NULL OR completed_at IS NOT NULL OR source_system IS NOT NULL)
);

CREATE UNIQUE INDEX job_milestones_import_identity_key
  ON nzi_console.job_milestones (organisation_id, source_system, legacy_db_id) WHERE source_system IS NOT NULL;

COMMENT ON TABLE nzi_console.job_milestones IS
  'A job''s delivery milestones (data collection, first draft, final report): due date and completion. Operational and mutable; the Risk rule reads it (src/milestoneRisk.ts). jobs.due_date plays no part in Risk.';
COMMENT ON COLUMN nzi_console.job_milestones.legacy_values IS
  'The v7 values this row was last loaded with. A re-run compares v7 against these, not against the row, so a console edit is never mistaken for a v7 change (ruled R3).';
COMMENT ON COLUMN nzi_console.job_milestones.completed_by_label IS
  'Who completed it, as the source recorded it (v7: free text). Staff, unsealed by ruling (R4); in the PII inventory.';
COMMENT ON COLUMN nzi_console.job_milestones.completed_by_user_id IS
  'The membership that completed it — set only on an exact, unique match; never guessed.';

ALTER TABLE nzi_console.job_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.job_milestones FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.job_milestones
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
REVOKE ALL ON nzi_console.job_milestones FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON nzi_console.job_milestones TO nzi_console_app;

COMMIT;
