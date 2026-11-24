-- 0234 Bring-in on a snapshotted job (BRIEF-v7-import-j000663 §B; ruled 24 Nov 2026, call 1: a new append-only table).
--
-- V7 is the live system and the source of truth, so a job snapshotted (reviewed and frozen) in the console may still bring in
-- V7's current rows. The snapshot is never edited: its row and bytes stay as history. This table records that a newer import
-- superseded it: one row per snapshot, written by the import.refresh commit in the same transaction as the bring-in, naming the
-- ingest (0229) that superseded it.
--
-- What reads it: validate and publish refuse a superseded snapshot (SNAPSHOT_SUPERSEDED), so the report must be re-composed from a
-- new snapshot; the job's report link reads "awaiting re-compose" (no published version) or "Published report is behind the
-- previous system — issue a new version" (a published version stands, untouched, until a new one supersedes it by the existing
-- route).
--
-- Ids only, no figures, no PII. Append-only: no update, no delete, for anyone (a trigger, beside the grants). Forced row-level
-- security with the tenant policy.

BEGIN;

CREATE TABLE nzi_console.reviewed_crp_snapshot_supersessions (
  organisation_id text NOT NULL,
  snapshot_id text NOT NULL,
  job_id text NOT NULL,
  superseded_by_ingest_id text NOT NULL,
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  correlation_id text NOT NULL CHECK (btrim(correlation_id) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, snapshot_id),
  FOREIGN KEY (organisation_id, snapshot_id) REFERENCES nzi_console.reviewed_crp_snapshots(organisation_id, snapshot_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id),
  FOREIGN KEY (organisation_id, superseded_by_ingest_id) REFERENCES nzi_console.v7_import_ingests(organisation_id, ingest_id)
);

CREATE INDEX reviewed_crp_snapshot_supersessions_job ON nzi_console.reviewed_crp_snapshot_supersessions (organisation_id, job_id);

CREATE FUNCTION nzi_console.reviewed_crp_snapshot_supersessions_are_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'reviewed_crp_snapshot_supersessions is append-only'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'reviewed_crp_snapshot_supersessions_are_append_only';
END;
$$;
CREATE TRIGGER reviewed_crp_snapshot_supersessions_are_append_only BEFORE UPDATE OR DELETE ON nzi_console.reviewed_crp_snapshot_supersessions
  FOR EACH ROW EXECUTE FUNCTION nzi_console.reviewed_crp_snapshot_supersessions_are_append_only();

COMMENT ON TABLE nzi_console.reviewed_crp_snapshot_supersessions IS
  'A reviewed snapshot superseded by a newer import from the previous system (0234). The snapshot itself is never edited. Written only by the import.refresh commit; append-only.';

ALTER TABLE nzi_console.reviewed_crp_snapshot_supersessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.reviewed_crp_snapshot_supersessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.reviewed_crp_snapshot_supersessions
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

REVOKE ALL ON nzi_console.reviewed_crp_snapshot_supersessions FROM PUBLIC;
GRANT SELECT, INSERT ON nzi_console.reviewed_crp_snapshot_supersessions TO nzi_console_app;

COMMIT;
