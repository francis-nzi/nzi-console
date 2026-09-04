BEGIN;

-- DA2 (NZC-057) — retire the CRP "Factor mapping" stage. The stage is removed
-- from `jobWorkflowStages.crp` in @nzi/contracts; existing CRP jobs sitting at
-- that (now invalid) stage are remapped to an adjacent valid one:
--   → "Data entry"   if any enabled scope row still lacks a factor
--   → "Review & QA"   otherwise
-- The remap is recorded in the immutable stage-transition trail as
-- "stage retired (NZC-057)". CRP-only — `pcf` keeps its "Factor mapping" stage.

WITH moved AS (
  UPDATE nzi_console.jobs j
  SET workflow_stage = CASE WHEN EXISTS (
        SELECT 1 FROM nzi_console.job_scope_rows r
        WHERE r.organisation_id = j.organisation_id
          AND r.job_id = j.job_id
          AND r.enabled = true
          AND r.factor_id IS NULL
          AND NOT (r.factor_source = 'client' AND r.client_factor_id IS NOT NULL)
      ) THEN 'Data entry' ELSE 'Review & QA' END,
      version = j.version + 1,
      updated_at = now()
  WHERE j.job_family = 'crp' AND j.workflow_stage = 'Factor mapping'
  RETURNING j.organisation_id, j.job_id, j.workflow_stage AS new_stage
)
INSERT INTO nzi_console.job_stage_history (organisation_id, stage_event_id, job_id, from_stage, to_stage, actor_id, note)
SELECT organisation_id, gen_random_uuid()::text, job_id, 'Factor mapping', new_stage, 'migration:nzc-057', 'stage retired (NZC-057)'
FROM moved;

-- Guard: no CRP job may remain at the retired stage.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM nzi_console.jobs WHERE job_family = 'crp' AND workflow_stage = 'Factor mapping') THEN
    RAISE EXCEPTION 'NZC-057 remap incomplete: CRP jobs still at "Factor mapping"';
  END IF;
END $$;

COMMIT;
