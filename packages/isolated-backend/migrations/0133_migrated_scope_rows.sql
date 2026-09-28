-- 0133 A migrated emissions figure is v7's, fixed — and the database says so (docs/CLIENT_JOB_IMPORT_DESIGN.md §5.1,
-- ruled 27–28 Sep 2026: immutable history; disable-only; decision 9 pending).
--
-- ## Why
--
-- Historical emissions from v7 are preserved exactly as v7 recorded them and are never re-resolved: the console's
-- resolver governs new capture only. They live in `job_scope_rows`, so every read path — totals, trajectory,
-- portal, intensity — shows history without being changed. That moves the risk to the write paths, which recompute
-- and reset a row on any edit; this closes them in the database, whoever writes.
--
-- ## What it adds
--
-- `origin` (`live` | `migrated`) and `migrated_record` (v7's row, verbatim) on `job_scope_rows`:
--
--   - a live row has no `migrated_record`; a migrated row must have one, and must carry the import identity (0132);
--   - `migrated_record` is a **closed list of keys** — v7's measurement, its copied factor, its figures, its
--     evidence — and can hold nothing else. In particular no personal data and no free text: v7's register
--     employee names, `detail_json` and row notes are not imported (§5.1, §7). An override's reason travels in the
--     row's own `override_reason`, as it does for new capture.
--
-- Two triggers make a migrated row immutable:
--
--   - UPDATE may change **only** `enabled` (with the `version` and `updated_at` that record the change) — the
--     disable-only ruling. Any other change is refused, as is turning a live row into a migrated one.
--   - DELETE of a migrated row is refused: deactivate, never delete.
--
-- ## A note for later migrations
--
-- A migration that backfills a column across `job_scope_rows` will be refused on migrated rows by the UPDATE
-- trigger. That is the point, and the way through is the owner's alone: `ALTER TABLE … DISABLE TRIGGER
-- job_scope_rows_migrated_immutable` around a reviewed backfill, re-enabled in the same transaction. No setting a
-- runtime role can change opens it.

BEGIN;

ALTER TABLE nzi_console.job_scope_rows
  ADD COLUMN origin text NOT NULL DEFAULT 'live' CHECK (origin IN ('live', 'migrated')),
  ADD COLUMN migrated_record jsonb;

ALTER TABLE nzi_console.job_scope_rows
  ADD CONSTRAINT job_scope_rows_migrated_shape CHECK (
    (origin = 'live' AND migrated_record IS NULL)
    OR (
      origin = 'migrated'
      AND source_system IS NOT NULL
      AND migrated_record IS NOT NULL
      AND jsonb_typeof(migrated_record) = 'object'
      -- What v7 recorded, every time.
      AND migrated_record ?& ARRAY['qty', 'uom', 'factor', 'ghg_unit', 'original_id', 'reported_tco2e', 'data_source', 'enabled']
      -- And nothing but the closed list: the record minus every allowed key must be empty.
      AND (migrated_record - ARRAY[
            'qty', 'uom', 'months', 'apply_pct',
            'factor', 'ghg_unit', 'original_id', 'factor_db_id', 'dataset',
            'reported_tco2e', 'stored_calc_tco2e', 'override_tco2e',
            'data_source', 'data_confidence', 'enabled', 'review_status',
            'register', 'evidence', 'flags'
          ]) = '{}'::jsonb
    )
  );

COMMENT ON COLUMN nzi_console.job_scope_rows.origin IS
  'live: captured in the console, resolved and recalculated by it. migrated: v7''s figure, fixed — never resolved or recalculated here (CLIENT_JOB_IMPORT_DESIGN §5.1).';
COMMENT ON COLUMN nzi_console.job_scope_rows.migrated_record IS
  'v7''s row as v7 recorded it: measurement, the factor v7 copied onto it, the figure v7 reported and the one it stored, and the evidence behind it. A closed key list; no personal data or free text.';

CREATE FUNCTION nzi_console.refuse_migrated_scope_row_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = nzi_console, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.origin = 'migrated' THEN
      RAISE EXCEPTION 'Scope row % is migrated history and cannot be deleted; disable it instead.', OLD.scope_row_id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.origin = 'live' AND NEW.origin <> 'live' THEN
    RAISE EXCEPTION 'Scope row % was captured here and cannot become migrated history.', OLD.scope_row_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.origin = 'migrated'
     AND (to_jsonb(NEW) - ARRAY['enabled', 'version', 'updated_at'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['enabled', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'Scope row % is migrated history: only whether it is enabled may change.', OLD.scope_row_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER job_scope_rows_migrated_immutable
  BEFORE UPDATE ON nzi_console.job_scope_rows
  FOR EACH ROW EXECUTE FUNCTION nzi_console.refuse_migrated_scope_row_change();

CREATE TRIGGER job_scope_rows_migrated_undeletable
  BEFORE DELETE ON nzi_console.job_scope_rows
  FOR EACH ROW EXECUTE FUNCTION nzi_console.refuse_migrated_scope_row_change();

COMMIT;
