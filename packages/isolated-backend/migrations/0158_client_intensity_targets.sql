BEGIN;

-- Redesign Phase 1b (ruled, JOB-WORKFLOW-rulings-round2.md; design note JOB-REDESIGN-phase1-design-note.md §1b) — the
-- intensity target moves to the Client, beside net zero. The metric itself is already the client's
-- (`client_intensity_metrics`, 0071); the job keeps only the year's Value (`job_intensity_values`, 0071). Until now the
-- target lived on the job (`job_intensity_targets`, 0014), one per job on a fixed turnover|employee|floor-area list —
-- the real organisation holds none, so there is nothing to move (ruled: no staging migration).
--
-- Versioned and append-only, the shape of `client_targets` (0069): a change writes the next version of that metric's
-- target, the one before stays readable, the current is the highest version. Deactivating writes a version with
-- `active = false`. The metric a target names must be an active metric of the client — checked by the command, because
-- `client_intensity_metrics` is itself versioned (its key carries the version), so no foreign key can name "the metric".
--
-- `job_intensity_targets` stays as written: read-only history, and every frozen snapshot keeps its payload. Its readers
-- move to this table in Phase 3.

CREATE TABLE nzi_console.client_intensity_targets (
  organisation_id text NOT NULL,
  client_id text NOT NULL,
  metric_key text NOT NULL CHECK (btrim(metric_key) <> ''),
  version integer NOT NULL CHECK (version > 0),

  -- The anchor: the intensity in the baseline year, in tCO2e per the metric's unit — stated, as the job form states it.
  baseline_year integer NOT NULL CHECK (baseline_year BETWEEN 2000 AND 2100),
  baseline_intensity numeric(20,6) NOT NULL CHECK (baseline_intensity >= 0),
  -- The commitments: a year and a percentage reduction from the baseline intensity, each travelling as a pair.
  interim_year integer CHECK (interim_year IS NULL OR (interim_year BETWEEN 2000 AND 2100)),
  interim_reduction_pct numeric(5,2) CHECK (interim_reduction_pct IS NULL OR (interim_reduction_pct >= 0 AND interim_reduction_pct <= 100)),
  target_year integer CHECK (target_year IS NULL OR (target_year BETWEEN 2000 AND 2100)),
  target_reduction_pct numeric(5,2) CHECK (target_reduction_pct IS NULL OR (target_reduction_pct >= 0 AND target_reduction_pct <= 100)),

  -- Deactivate, never delete: the metric's target is withdrawn by a version that says so.
  active boolean NOT NULL DEFAULT true,
  /* Why this version exists — required to deactivate or to move the baseline (the command checks which). */
  reason text CHECK (reason IS NULL OR (reason = trim(reason) AND reason <> '')),
  set_by text NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text NOT NULL,

  PRIMARY KEY (organisation_id, client_id, metric_key, version),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id),
  CONSTRAINT client_intensity_targets_interim_pair CHECK ((interim_year IS NULL) = (interim_reduction_pct IS NULL)),
  CONSTRAINT client_intensity_targets_target_pair CHECK ((target_year IS NULL) = (target_reduction_pct IS NULL)),
  -- A reduction is measured from the baseline, so its year comes after it; the interim comes before the target.
  CONSTRAINT client_intensity_targets_after_baseline CHECK (
    (interim_year IS NULL OR interim_year > baseline_year) AND (target_year IS NULL OR target_year > baseline_year)),
  CONSTRAINT client_intensity_targets_interim_before_target CHECK (
    interim_year IS NULL OR target_year IS NULL OR (interim_year < target_year AND interim_reduction_pct <= target_reduction_pct)),
  -- A withdrawal says why.
  CONSTRAINT client_intensity_targets_deactivation_reason CHECK (active OR reason IS NOT NULL)
);
CREATE INDEX client_intensity_targets_current_idx ON nzi_console.client_intensity_targets (organisation_id, client_id, metric_key, version DESC);

ALTER TABLE nzi_console.client_intensity_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_intensity_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_intensity_targets
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
-- Append-only: a change is a new version, never an edit of the one before it.
GRANT SELECT, INSERT ON nzi_console.client_intensity_targets TO nzi_console_app;
REVOKE UPDATE, DELETE ON nzi_console.client_intensity_targets FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

COMMIT;
