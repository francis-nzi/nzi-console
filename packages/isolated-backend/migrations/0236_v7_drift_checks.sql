-- 0236 The drift guard's checks (BRIEF-v7-import-j000663 Part C; CONTRACT-v7-import-figures v1; ruled 25 Nov 2026: a stored check).
--
-- V7 is the live system, so a job imported from it must not be reported once it has fallen behind V7. Each check reads V7's own
-- scope totals for one job (the contract's endpoint 1, computed by V7's report code) beside the console's, and is stored here:
-- one row per check, append-only. The banner, the Admin list and the publish gate read a job's latest row, so a publish never
-- calls V7 inside its transaction.
--
-- Checks run from the Admin list ("Check now"), just before a publish, and nightly. A check V7 could not answer is stored as
-- `unknown`, with a code and no V7 figure: unknown is never a zero and never "level".
--
-- Figures only (tCO2e per scope), ids and codes. No PII, nothing of V7's rows. Forced row-level security with the tenant policy.

BEGIN;

CREATE TABLE nzi_console.v7_drift_checks (
  organisation_id text NOT NULL,
  check_id text NOT NULL,
  job_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('level', 'behind', 'unknown')),
  trigger text NOT NULL CHECK (trigger IN ('admin', 'publish', 'nightly')),
  unknown_reason text CHECK (unknown_reason IS NULL OR unknown_reason ~ '^[a-z-]{1,32}$'),
  console_scope1_tco2e numeric NOT NULL,
  console_scope2_tco2e numeric NOT NULL,
  console_scope3_tco2e numeric NOT NULL,
  v7_scope1_tco2e numeric,
  v7_scope2_tco2e numeric,
  v7_scope3_tco2e numeric,
  max_difference_tco2e numeric,
  v7_computed_at timestamptz,
  v7_rows_updated_at timestamptz,
  requested_by text NOT NULL CHECK (btrim(requested_by) <> ''),
  correlation_id text NOT NULL CHECK (btrim(correlation_id) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, check_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id),
  -- A known outcome carries V7's three totals and the difference; unknown carries its reason and none of V7's figures.
  CONSTRAINT v7_drift_checks_known_has_figures CHECK (
    (outcome = 'unknown' AND unknown_reason IS NOT NULL AND v7_scope1_tco2e IS NULL AND v7_scope2_tco2e IS NULL AND v7_scope3_tco2e IS NULL AND max_difference_tco2e IS NULL)
    OR (outcome <> 'unknown' AND unknown_reason IS NULL AND v7_scope1_tco2e IS NOT NULL AND v7_scope2_tco2e IS NOT NULL AND v7_scope3_tco2e IS NOT NULL
        AND max_difference_tco2e IS NOT NULL AND v7_computed_at IS NOT NULL))
);

-- The latest check per job: the gate's and the banner's one read.
CREATE INDEX v7_drift_checks_latest ON nzi_console.v7_drift_checks (organisation_id, job_id, created_at DESC, check_id DESC);

CREATE FUNCTION nzi_console.v7_drift_checks_are_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'v7_drift_checks is append-only'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'v7_drift_checks_are_append_only';
END;
$$;
CREATE TRIGGER v7_drift_checks_are_append_only BEFORE UPDATE OR DELETE ON nzi_console.v7_drift_checks
  FOR EACH ROW EXECUTE FUNCTION nzi_console.v7_drift_checks_are_append_only();

COMMENT ON TABLE nzi_console.v7_drift_checks IS
  'A check of one imported job''s scope totals against the previous system''s own (0236; CONTRACT-v7-import-figures v1). Append-only; the latest row per job drives the banner, the Admin list and the publish gate.';

ALTER TABLE nzi_console.v7_drift_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.v7_drift_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.v7_drift_checks
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

REVOKE ALL ON nzi_console.v7_drift_checks FROM PUBLIC;
GRANT SELECT, INSERT ON nzi_console.v7_drift_checks TO nzi_console_app;

COMMIT;
