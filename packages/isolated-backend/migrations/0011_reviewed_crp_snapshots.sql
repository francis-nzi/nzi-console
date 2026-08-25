BEGIN;

CREATE TABLE nzi_console.reviewed_crp_snapshots (
  organisation_id text NOT NULL,
  snapshot_id text NOT NULL,
  job_id text NOT NULL,
  snapshot_version integer NOT NULL CHECK (snapshot_version>0),
  job_version integer NOT NULL CHECK (job_version>0),
  data_hash text NOT NULL CHECK (data_hash ~ '^sha256:[0-9a-f]{64}$'),
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json)='object'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id,snapshot_id),
  FOREIGN KEY (organisation_id,job_id) REFERENCES nzi_console.jobs(organisation_id,job_id),
  UNIQUE (organisation_id,job_id,snapshot_version),
  UNIQUE (organisation_id,job_id,data_hash)
);

ALTER TABLE nzi_console.reviewed_crp_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.reviewed_crp_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.reviewed_crp_snapshots USING (organisation_id=current_setting('app.organisation_id',true)) WITH CHECK (organisation_id=current_setting('app.organisation_id',true));
GRANT SELECT,INSERT ON nzi_console.reviewed_crp_snapshots TO nzi_console_app;
REVOKE UPDATE,DELETE ON nzi_console.reviewed_crp_snapshots FROM nzi_console_app;

COMMIT;
