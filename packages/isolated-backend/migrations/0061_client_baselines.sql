-- 0061 The baseline is a dated record, not fields on the client (NZC-065/068).
--
-- Migration 0060 put baseline period + S1/S2/S3 + total on `clients` as mutable
-- fields — live's model with the four-way split removed but the overwrite kept.
-- `clients.version` records *that* a save happened, not *what the baseline was
-- before it*, so re-baselining still retroactively restated every report a client
-- had ever had, and a baseline period later than a report's own reporting period
-- was possible by construction (the J000699 failure).
--
-- `client_baselines` is append-only: a re-baseline writes a new row and supersedes
-- the old one. Nothing is overwritten, so an old report can still resolve the
-- baseline it was issued against. Enforced in the command layer (`client.baseline.*`);
-- the only field ever updated here is `superseded_at`.

BEGIN;

SET search_path = nzi_console;

CREATE TABLE nzi_console.client_baselines (
  organisation_id text NOT NULL,
  baseline_id text NOT NULL,
  client_id text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  -- Either a baseline job, or typed figures. Both first-class: some clients'
  -- baselines predate the platform entirely, which is what live's cached
  -- benchmark_*_tco2e columns are genuinely for.
  baseline_job_id text,
  scope1_tco2e numeric,
  scope2_tco2e numeric,
  scope3_tco2e numeric,
  total_tco2e numeric,
  -- GHG Protocol treats recalculating a base year after a structural change as a
  -- different act from choosing a new one; they carry different disclosure duties.
  kind text NOT NULL CHECK (kind IN ('initial','rebaseline','recalculation')),
  source text NOT NULL CHECK (source IN ('assured','declared','migrated_unverified')),
  reason text,
  set_by text NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  -- The first reporting period this record governs — not the same as when it was entered.
  effective_from date NOT NULL,
  superseded_at timestamptz,
  PRIMARY KEY (organisation_id, baseline_id),
  FOREIGN KEY (organisation_id, client_id)
    REFERENCES nzi_console.clients(organisation_id, client_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, baseline_job_id)
    REFERENCES nzi_console.jobs(organisation_id, job_id),
  CONSTRAINT client_baselines_period_check CHECK (period_end > period_start),
  -- A baseline must be *something*: a job to resolve, or figures to use.
  CONSTRAINT client_baselines_evidence_check
    CHECK (baseline_job_id IS NOT NULL OR total_tco2e IS NOT NULL),
  -- NZC-068: re-basing is a governed act, so anything other than the first
  -- baseline has to say why.
  CONSTRAINT client_baselines_reason_check
    CHECK (kind = 'initial' OR nullif(trim(reason), '') IS NOT NULL),
  CONSTRAINT client_baselines_figures_check CHECK (
    (scope1_tco2e IS NULL OR scope1_tco2e >= 0) AND
    (scope2_tco2e IS NULL OR scope2_tco2e >= 0) AND
    (scope3_tco2e IS NULL OR scope3_tco2e >= 0) AND
    (total_tco2e  IS NULL OR total_tco2e  >= 0)
  )
);

CREATE INDEX client_baselines_client_idx
  ON nzi_console.client_baselines(organisation_id, client_id, effective_from DESC, set_at DESC);
-- At most one baseline may take effect from a given date for a client.
CREATE UNIQUE INDEX client_baselines_effective_unique
  ON nzi_console.client_baselines(organisation_id, client_id, effective_from);

ALTER TABLE nzi_console.client_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_baselines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_baselines
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

-- No DELETE: the record is append-only, and superseding is an UPDATE of `superseded_at`.
GRANT SELECT, INSERT, UPDATE ON nzi_console.client_baselines TO nzi_console_app;

-- A base-year recalculation policy has to state a significance threshold, and there
-- was nowhere to record one.
ALTER TABLE nzi_console.clients
  ADD COLUMN baseline_significance_threshold_pct numeric,
  ADD CONSTRAINT clients_baseline_threshold_check
    CHECK (baseline_significance_threshold_pct IS NULL
           OR (baseline_significance_threshold_pct > 0 AND baseline_significance_threshold_pct <= 100));

-- Carry the existing client baselines into the record. These are the synthetic
-- demonstrator values from seed 0011 — typed figures, so `declared`. Live baseline
-- data is deliberately NOT migrated here (MODEL_FIDELITY_BASELINE.md §5): live's own
-- triage of the mismatched jobs must complete first, or a seed converts known-bad
-- data into an audit record, which is worse than a cache.
INSERT INTO nzi_console.client_baselines (
  organisation_id, baseline_id, client_id, period_start, period_end,
  scope1_tco2e, scope2_tco2e, scope3_tco2e, total_tco2e,
  kind, source, reason, set_by, effective_from
)
SELECT
  organisation_id,
  'bl-' || client_id || '-' || to_char(baseline_period_start, 'YYYY'),
  client_id, baseline_period_start, baseline_period_end,
  baseline_scope1_tco2e, baseline_scope2_tco2e, baseline_scope3_tco2e, baseline_total_tco2e,
  'initial', 'declared', NULL, 'migration-0061', baseline_period_start
FROM nzi_console.clients
WHERE baseline_period_start IS NOT NULL
  AND baseline_period_end IS NOT NULL
  AND baseline_total_tco2e IS NOT NULL;

-- Retire the mutable fields. Leaving them would recreate live's split, where which
-- field happens to be populated decides which screen believes what.
ALTER TABLE nzi_console.clients
  DROP CONSTRAINT IF EXISTS clients_baseline_period_check,
  DROP CONSTRAINT IF EXISTS clients_baseline_emissions_check,
  DROP COLUMN baseline_period_start,
  DROP COLUMN baseline_period_end,
  DROP COLUMN baseline_scope1_tco2e,
  DROP COLUMN baseline_scope2_tco2e,
  DROP COLUMN baseline_scope3_tco2e,
  DROP COLUMN baseline_total_tco2e;

COMMIT;
