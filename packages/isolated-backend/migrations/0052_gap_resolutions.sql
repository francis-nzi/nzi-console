BEGIN;

-- DA1d (NZC-060) — Data-integrity gap resolutions. Each gap the assurance engine
-- raises before sign-off is either fixed (edit the row) or resolved-with-reason.
-- A resolution is keyed to the job + the engine's deterministic gap key so it
-- sticks across recomputes; `scope_row_id` is set when the gap is row-scoped so
-- the reason surfaces on that row's provenance. Re-resolving overwrites the
-- reason (audited via the command); rows are never hard-deleted. The frozen set
-- is copied into the reviewed-snapshot payload at sign-off so a sign-off is
-- reproducible.

CREATE TABLE nzi_console.gap_resolutions (
  organisation_id text NOT NULL,
  resolution_id text NOT NULL,
  job_id text NOT NULL,
  gap_key text NOT NULL,
  flag_type text NOT NULL CHECK (flag_type IN ('yoy_movement','completeness','zero_blank','unmapped')),
  scope_row_id text,
  reason text NOT NULL CHECK (nullif(trim(reason),'') IS NOT NULL),
  resolved_by text NOT NULL,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, resolution_id),
  UNIQUE (organisation_id, job_id, gap_key),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id)
);

CREATE INDEX gap_resolutions_job_idx ON nzi_console.gap_resolutions (organisation_id, job_id);

ALTER TABLE nzi_console.gap_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.gap_resolutions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.gap_resolutions
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.gap_resolutions TO nzi_console_app;
REVOKE DELETE ON nzi_console.gap_resolutions FROM nzi_console_app;

COMMENT ON TABLE nzi_console.gap_resolutions IS
  'DA1d/NZC-060 resolved-with-reason integrity gaps; keyed to job + engine gap_key, frozen into the reviewed snapshot at sign-off.';

COMMIT;
