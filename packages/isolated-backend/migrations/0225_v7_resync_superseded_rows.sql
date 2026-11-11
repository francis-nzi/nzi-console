-- 0225 A v7 row that v7 has since changed is superseded, never edited (RULING-v7-resync-job v2, Route B).
--
-- ## Why
--
-- 0133 keeps a migrated row exactly as v7 recorded it, and 0132 lets one row per v7 record exist. When v7 changes a
-- record after migration, the console's copy is stale, and the loader refuses the whole client ("v7 changed after
-- migration"). The re-sync of one named job brings it current without touching what 0133 protects: the stale row is
-- superseded (switched off and marked), and v7's current record is inserted beside it as a new migrated row. Nothing
-- is deleted, no migrated record is edited, and the trigger is never disabled. Reverting the re-sync flips it back.
--
-- ## What it adds
--
--   - `superseded_by_run`: the `v7-resync-<uuid>` run that superseded the row, or NULL for the current one. Only a
--     migrated row is superseded, and a superseded row is always switched off — so every reader that counts enabled
--     rows (totals, trajectory, portal, charts) is unaffected by construction.
--   - 0132's import identity on `job_scope_rows` is re-scoped to the current rows: one current row per v7 record, as
--     before; the superseded ones are kept beside it.
--   - 0133's immutability function lets `superseded_by_run` change too, alongside `enabled`. Every other column of a
--     migrated row stays immutable, and DELETE stays refused; the refusals' wording is 0133's own. CREATE OR REPLACE keeps
--     both triggers bound (as 0136).

BEGIN;

ALTER TABLE nzi_console.job_scope_rows ADD COLUMN superseded_by_run text;

ALTER TABLE nzi_console.job_scope_rows
  ADD CONSTRAINT job_scope_rows_superseded_shape CHECK (
    superseded_by_run IS NULL
    OR (superseded_by_run ~ '^v7-resync-[0-9a-f-]{36}$' AND origin = 'migrated' AND NOT enabled)
  );

COMMENT ON COLUMN nzi_console.job_scope_rows.superseded_by_run IS
  'The v7 re-sync run (v7-resync-<uuid>) that superseded this migrated row with v7''s current record, or NULL for the current row. A superseded row is always switched off (0225).';

DROP INDEX nzi_console.job_scope_rows_import_identity_key;
CREATE UNIQUE INDEX job_scope_rows_import_identity_key
  ON nzi_console.job_scope_rows (organisation_id, source_system, legacy_db_id)
  WHERE source_system IS NOT NULL AND superseded_by_run IS NULL;

CREATE OR REPLACE FUNCTION nzi_console.refuse_migrated_scope_row_change() RETURNS trigger
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
     AND (to_jsonb(NEW) - ARRAY['enabled', 'superseded_by_run', 'version', 'updated_at'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['enabled', 'superseded_by_run', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'Scope row % is migrated history: only whether it is enabled may change.', OLD.scope_row_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
