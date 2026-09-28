-- 0134 New jobs number on from the highest job that exists — imported v7 numbers included
-- (docs/CLIENT_JOB_IMPORT_DESIGN.md §4, decision 1a, ruled 27 Sep 2026).
--
-- ## Why
--
-- Imported jobs keep v7's official numbers (`J000612`…): the import writes each job's `sequence` as v7's number.
-- The counter that `allocate_job_sequence()` (0001) advances knows nothing of them, so without this the next job
-- created here would be handed a number an imported job already holds, and `sequence` is globally unique.
--
-- ## What it adds
--
-- `nzi_console.advance_job_sequence_past_existing()` — sets the counter to the highest `sequence` any job holds, if
-- that is higher than where the counter stands. It never moves the counter back, and it takes **no argument**: it
-- can only catch the counter up to numbers that genuinely exist, never push it ahead of them — which is what keeps
-- NZC-025's gapless allocation gapless. It reads every organisation's jobs, each as its own tenant, because the
-- counter is one sequence across all of them.
--
-- SECURITY DEFINER, like `allocate_job_sequence()`, because the runtime roles cannot touch the counter (0002).
-- EXECUTE is granted to the application role, which the import runs as.

BEGIN;

CREATE FUNCTION nzi_console.advance_job_sequence_past_existing() RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nzi_console, pg_temp
AS $$
DECLARE
  org text;
  highest integer := 0;
  found integer;
  settled integer;
  caller_tenant text := current_setting('app.organisation_id', true);
BEGIN
  FOR org IN SELECT organisation_id FROM nzi_console.organisations LOOP
    PERFORM set_config('app.organisation_id', org, true);
    SELECT max(sequence) INTO found FROM nzi_console.jobs;
    highest := greatest(highest, coalesce(found, 0));
  END LOOP;
  PERFORM set_config('app.organisation_id', coalesce(caller_tenant, ''), true);

  UPDATE nzi_console.job_number_counter
     SET last_sequence = greatest(last_sequence, highest)
   WHERE singleton
  RETURNING last_sequence INTO settled;
  RETURN settled;
END;
$$;

REVOKE ALL ON FUNCTION nzi_console.advance_job_sequence_past_existing() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nzi_console.advance_job_sequence_past_existing() TO nzi_console_app;

COMMENT ON FUNCTION nzi_console.advance_job_sequence_past_existing() IS
  'Catches the job-number counter up to the highest existing sequence (imported v7 numbers included). Never moves it back or past a number that exists (NZC-025, decision 1a).';

COMMIT;
