-- 0114 A distributed row must say what grain it was distributed from (NZC-152).
--
-- 0094 wrote this, on `job_scope_rows` and `job_emission_sources` alike:
--
--   CHECK (activity_distributed = false OR activity_frequency = ANY (ARRAY['annual','quarterly']))
--
-- It says: if the monthly values were derived rather than typed, they were derived from an annual or a
-- quarterly figure. It does not enforce that. With `activity_distributed = true` and `activity_frequency`
-- NULL the expression is `false OR NULL`, which is NULL, and **the row is admitted** — so a row may claim
-- its months were derived while recording nothing about what they were derived from.
--
-- This is the third appearance of one mistake: a CHECK is satisfied by NULL, so a disjunction whose live
-- branch compares a nullable column passes whenever that column is null. It admitted every hideable row
-- in 0109 (NZC-143) and it silently disabled a uniqueness guarantee in 0113 (NZC-151). Found this time by
-- reading every constraint in the schema rather than by waiting for the next defect.
--
-- **A latent gap rather than a live one.** Both write paths set frequency and distributed together, from
-- one resolver, so nothing in the application is known to reach the admitted state. That makes this a last
-- line of defence that does not hold — which is worth closing precisely because the day it matters is the
-- day something else has already gone wrong.
--
-- **The rows are counted before the constraint is tightened.** `ALTER TABLE ... ADD CONSTRAINT` validates
-- existing rows and would fail on its own, so the checks below add no safety; what they add is a legible
-- failure. Without them a deploy stops on `violates check constraint` naming neither how many rows nor
-- which state they are in, and the person reading it at the time will not have this file open.
--
-- Deliberately **not** repaired automatically. A row claiming derivation with no grain recorded cannot
-- have one inferred — annual and quarterly produce different months from the same figure, and guessing
-- would write a provenance nobody established.

BEGIN;

DO $$
DECLARE
  offending bigint;
BEGIN
  SELECT count(*) INTO offending
    FROM nzi_console.job_scope_rows
   WHERE activity_distributed = true AND activity_frequency IS NULL;

  IF offending > 0 THEN
    RAISE EXCEPTION
      'job_scope_rows: % row(s) claim activity_distributed = true with no activity_frequency. '
      'The tightened constraint refuses them and this migration will not guess a grain: annual and '
      'quarterly produce different months from the same figure. Establish the grain for those rows, or '
      'set activity_distributed = false where the months were typed rather than derived, then re-run.',
      offending;
  END IF;
END $$;

DO $$
DECLARE
  offending bigint;
BEGIN
  SELECT count(*) INTO offending
    FROM nzi_console.job_emission_sources
   WHERE activity_distributed = true AND activity_frequency IS NULL;

  IF offending > 0 THEN
    RAISE EXCEPTION
      'job_emission_sources: % row(s) claim activity_distributed = true with no activity_frequency. '
      'See the note on job_scope_rows above — the grain is not inferable and is not guessed here.',
      offending;
  END IF;
END $$;

-- The same constraint on both tables, with the null closed. `IS NOT NULL AND` rather than a COALESCE to a
-- sentinel: the intent is "a distributed row names its grain", and saying that is better than comparing
-- against an empty string that means nothing in this column.
ALTER TABLE nzi_console.job_scope_rows
  DROP CONSTRAINT job_scope_rows_distribution_grain;

ALTER TABLE nzi_console.job_scope_rows
  ADD CONSTRAINT job_scope_rows_distribution_grain CHECK (
    activity_distributed = false
    OR (activity_frequency IS NOT NULL AND activity_frequency IN ('annual', 'quarterly'))
  );

ALTER TABLE nzi_console.job_emission_sources
  DROP CONSTRAINT job_emission_sources_distribution_grain;

ALTER TABLE nzi_console.job_emission_sources
  ADD CONSTRAINT job_emission_sources_distribution_grain CHECK (
    activity_distributed = false
    OR (activity_frequency IS NOT NULL AND activity_frequency IN ('annual', 'quarterly'))
  );

COMMIT;
