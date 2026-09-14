-- 0077 — What an issued report actually freezes.
--
-- `reviewed_crp_snapshots` freezes the MEASUREMENT: what was emitted, with its factors,
-- quality tiers and provenance. That is not the whole report. A report also states the
-- client's intensity, their targets, their decarbonisation plan and their SRS readiness —
-- and every one of those is a live record that goes on changing after the report is sent.
--
-- So issuing a report freezes a COMPOSITION: the snapshot it rests on, plus the state of
-- everything else it quotes, as at that moment. Without this table, a consultant editing
-- next week's plan would silently rewrite a report the client already holds. That is the
-- exact failure immutability exists to prevent, and pinning only the snapshot would have
-- looked like it was prevented while leaving three sections free to drift.
--
-- Content-addressed and append-only, the same shape as the reviewed snapshot it wraps:
-- re-issuing the same facts reuses the row rather than minting a second truth.

BEGIN;

CREATE TABLE nzi_console.report_compositions (
  organisation_id text NOT NULL,
  composition_id text NOT NULL,
  report_version_id text NOT NULL,
  job_id text NOT NULL,
  /* The measurement this composition rests on, carried explicitly so the two cannot drift
     apart even if the report version were ever re-pointed. */
  reviewed_snapshot_id text NOT NULL,
  snapshot_data_hash text NOT NULL CHECK (nullif(trim(snapshot_data_hash), '') IS NOT NULL),
  data_hash text NOT NULL CHECK (nullif(trim(data_hash), '') IS NOT NULL),
  payload_json jsonb NOT NULL,
  issued_by text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, composition_id),
  FOREIGN KEY (organisation_id, report_version_id) REFERENCES nzi_console.report_versions(organisation_id, report_version_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id) ON DELETE CASCADE
);

-- One composition per issued report version. A report version is a thing the client was
-- sent; it cannot mean two different documents.
CREATE UNIQUE INDEX report_compositions_version_idx
  ON nzi_console.report_compositions (organisation_id, report_version_id);
-- Re-issuing identical facts finds the existing row instead of writing a second one.
CREATE UNIQUE INDEX report_compositions_hash_idx
  ON nzi_console.report_compositions (organisation_id, report_version_id, data_hash);

COMMENT ON TABLE nzi_console.report_compositions IS
  'What an issued report froze: the reviewed measurement snapshot plus the intensity, targets, plan and SRS readiness as at issue. Immutable — a correction is a new report version, never an edit to this row.';
COMMENT ON COLUMN nzi_console.report_compositions.payload_json IS
  'The frozen ReportComposition. Every figure arrives already resolved by the domain that owns it; nothing in here is recomputed at render time.';

ALTER TABLE nzi_console.report_compositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.report_compositions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.report_compositions
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

-- Insert and read only. An issued report is evidence: correcting it means issuing a new
-- version, so nothing on the platform needs to be able to edit or remove one.
GRANT SELECT, INSERT ON nzi_console.report_compositions TO nzi_console_app;
REVOKE UPDATE, DELETE ON nzi_console.report_compositions FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

COMMIT;
