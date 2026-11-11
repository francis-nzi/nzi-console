-- 0225 A v7 row that v7 has since changed is superseded, never edited (RULING-v7-resync-job v2, Route B).
--
-- ## Why
--
-- 0133 keeps a migrated row exactly as v7 recorded it, and 0132 lets one row per v7 record exist. When v7 changes a
-- record after migration, the console's copy is stale, and the loader refuses the whole client ("v7 changed after
-- migration"). The re-sync of one named job brings it current without touching what 0133 protects: the stale row is
-- superseded (switched off and pointed at its replacement), and v7's current record is inserted beside it as a new
-- migrated row. Nothing is deleted, no migrated record is edited, and no trigger is ever disabled. The superseded rows are
-- kept in place, so they are their own before-image: there is no before-image table.
--
-- ## What it adds
--
--   - `job_scope_rows.superseded_by_row_id`: the row that replaced this one, or NULL for the current row. Only a migrated
--     row carries it, and a superseded row is always switched off — so every reader that counts enabled rows (totals,
--     trajectory, portal, charts) is unaffected by construction. A revert points the replacement back at the row it
--     replaced, so a v7 record keeps exactly one current row throughout.
--   - 0132's import identity on `job_scope_rows` is re-scoped to the current (non-superseded) rows: still at most one
--     current row per v7 record, with the superseded ones kept beside it.
--   - 0133's immutability function lets `superseded_by_row_id` change too, alongside `enabled` — and nothing else. Every
--     other column of a migrated row stays immutable, DELETE stays refused, and the refusals' wording is 0133's own.
--     CREATE OR REPLACE keeps both triggers bound (as 0136).
--   - `v7_resync_runs`: one row per re-sync run of a job — the extract it read, counts only (no figures, NZC-120), and
--     whether it was later reverted. At most one completed run per job.

BEGIN;

ALTER TABLE nzi_console.job_scope_rows ADD COLUMN superseded_by_row_id text;

ALTER TABLE nzi_console.job_scope_rows
  ADD CONSTRAINT job_scope_rows_superseded_by_fk
  FOREIGN KEY (organisation_id, superseded_by_row_id)
  REFERENCES nzi_console.job_scope_rows(organisation_id, scope_row_id)
  -- The old row is marked before its replacement is inserted (the identity key allows one current row), so the re-sync
  -- defers this check across that swap and makes it immediate again straight after; every other writer sees it immediate.
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE nzi_console.job_scope_rows
  ADD CONSTRAINT job_scope_rows_superseded_shape CHECK (
    superseded_by_row_id IS NULL
    OR (origin = 'migrated' AND NOT enabled AND superseded_by_row_id <> scope_row_id)
  );

COMMENT ON COLUMN nzi_console.job_scope_rows.superseded_by_row_id IS
  'The migrated row that superseded this one with v7''s current record (v7 re-sync, 0225), or NULL for the current row. A superseded row is always switched off.';

DROP INDEX nzi_console.job_scope_rows_import_identity_key;
CREATE UNIQUE INDEX job_scope_rows_import_identity_key
  ON nzi_console.job_scope_rows (organisation_id, source_system, legacy_db_id)
  WHERE source_system IS NOT NULL AND superseded_by_row_id IS NULL;

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
     AND (to_jsonb(NEW) - ARRAY['enabled', 'superseded_by_row_id', 'version', 'updated_at'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['enabled', 'superseded_by_row_id', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'Scope row % is migrated history: only whether it is enabled may change.', OLD.scope_row_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TABLE nzi_console.v7_resync_runs (
  organisation_id text NOT NULL,
  run_id text NOT NULL CHECK (run_id ~ '^v7-resync-[0-9a-f-]{36}$'),
  job_id text NOT NULL,
  extract_sha256 text NOT NULL CHECK (extract_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'reverted')),
  rows_unchanged integer NOT NULL CHECK (rows_unchanged >= 0),
  rows_superseded integer NOT NULL CHECK (rows_superseded >= 0),
  rows_added integer NOT NULL CHECK (rows_added >= 0),
  rows_withdrawn integer NOT NULL CHECK (rows_withdrawn >= 0),
  reason text NOT NULL CHECK (reason = btrim(reason) AND reason <> ''),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text NOT NULL,
  reverted_by text,
  reverted_at timestamptz,
  revert_reason text CHECK (revert_reason IS NULL OR (revert_reason = btrim(revert_reason) AND revert_reason <> '')),
  PRIMARY KEY (organisation_id, run_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id),
  CONSTRAINT v7_resync_runs_changed_something CHECK (rows_superseded + rows_added + rows_withdrawn > 0),
  CONSTRAINT v7_resync_runs_revert_shape CHECK (
    (status = 'reverted') = (reverted_by IS NOT NULL AND reverted_at IS NOT NULL AND revert_reason IS NOT NULL))
);
CREATE UNIQUE INDEX v7_resync_runs_one_completed_per_job_idx
  ON nzi_console.v7_resync_runs (organisation_id, job_id) WHERE status = 'completed';

COMMENT ON TABLE nzi_console.v7_resync_runs IS
  'One row per v7 re-sync of one named job (0225): the extract read, counts only (no tCO2e, no quantities), and the revert stamp. The rows it touched are named by its audit events.';

ALTER TABLE nzi_console.v7_resync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.v7_resync_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.v7_resync_runs
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
-- Written once; the only later change is the revert stamp. Never deleted.
GRANT SELECT, INSERT ON nzi_console.v7_resync_runs TO nzi_console_app;
GRANT UPDATE (status, reverted_by, reverted_at, revert_reason) ON nzi_console.v7_resync_runs TO nzi_console_app;
REVOKE DELETE ON nzi_console.v7_resync_runs FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

COMMIT;
