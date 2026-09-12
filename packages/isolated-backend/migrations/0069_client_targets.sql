BEGIN;

-- NZC-072 — the forward target model, kept distinct from the baseline.
--
-- The baseline is the past anchor (tonnes, measured, restated only through a governed
-- re-baseline). Targets are the forward commitment: years and percentage reductions
-- measured against that benchmark. Two records, two kinds of governance.
--
-- Versioned and append-only: a change writes the next version, the one before it stays
-- readable, and the current target is the highest version. Each version stamps the
-- benchmark it was set against, so a later re-baseline cannot silently restate what a
-- client committed to (NZC-068) — the targets are held, and show as standing on a
-- superseded benchmark until someone restates them deliberately.

CREATE TABLE nzi_console.client_targets (
  organisation_id text NOT NULL,
  client_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),

  -- The forward commitment. Any milestone may be unset; a year and its percentage travel together.
  near_term_year integer CHECK (near_term_year IS NULL OR (near_term_year BETWEEN 2000 AND 2100)),
  near_term_pct numeric(5,2) CHECK (near_term_pct IS NULL OR (near_term_pct >= 0 AND near_term_pct <= 100)),
  net_zero_year integer CHECK (net_zero_year IS NULL OR (net_zero_year BETWEEN 2000 AND 2100)),
  net_zero_pct numeric(5,2) CHECK (net_zero_pct IS NULL OR (net_zero_pct >= 0 AND net_zero_pct <= 100)),
  scope1_year integer CHECK (scope1_year IS NULL OR (scope1_year BETWEEN 2000 AND 2100)),
  scope1_pct numeric(5,2) CHECK (scope1_pct IS NULL OR (scope1_pct >= 0 AND scope1_pct <= 100)),
  scope2_year integer CHECK (scope2_year IS NULL OR (scope2_year BETWEEN 2000 AND 2100)),
  scope2_pct numeric(5,2) CHECK (scope2_pct IS NULL OR (scope2_pct >= 0 AND scope2_pct <= 100)),
  scope3_year integer CHECK (scope3_year IS NULL OR (scope3_year BETWEEN 2000 AND 2100)),
  scope3_pct numeric(5,2) CHECK (scope3_pct IS NULL OR (scope3_pct >= 0 AND scope3_pct <= 100)),

  -- The benchmark this version was set against — read from the baseline in force, never typed here.
  benchmark_year integer NOT NULL CHECK (benchmark_year BETWEEN 2000 AND 2100),
  benchmark_total_tco2e numeric(14,3) NOT NULL CHECK (benchmark_total_tco2e >= 0),
  benchmark_scope1_tco2e numeric(14,3),
  benchmark_scope2_tco2e numeric(14,3),
  benchmark_scope3_tco2e numeric(14,3),
  benchmark_source text NOT NULL CHECK (benchmark_source IN ('client-record','baseline-record')),
  benchmark_ref text,

  /* Why this version exists: required when it restates targets onto a moved benchmark. */
  reason text CHECK (reason IS NULL OR (reason = trim(reason) AND reason <> '')),
  restated_benchmark boolean NOT NULL DEFAULT false,
  set_by text NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text NOT NULL,

  PRIMARY KEY (organisation_id, client_id, version),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id),
  CONSTRAINT client_targets_near_term_pair CHECK ((near_term_year IS NULL) = (near_term_pct IS NULL)),
  CONSTRAINT client_targets_net_zero_pair CHECK ((net_zero_year IS NULL) = (net_zero_pct IS NULL)),
  CONSTRAINT client_targets_scope1_pair CHECK ((scope1_year IS NULL) = (scope1_pct IS NULL)),
  CONSTRAINT client_targets_scope2_pair CHECK ((scope2_year IS NULL) = (scope2_pct IS NULL)),
  CONSTRAINT client_targets_scope3_pair CHECK ((scope3_year IS NULL) = (scope3_pct IS NULL)),
  -- A target is a reduction from the benchmark, so it has to come after it.
  CONSTRAINT client_targets_after_benchmark CHECK (
    (near_term_year IS NULL OR near_term_year > benchmark_year)
    AND (net_zero_year IS NULL OR net_zero_year > benchmark_year)
    AND (scope1_year IS NULL OR scope1_year > benchmark_year)
    AND (scope2_year IS NULL OR scope2_year > benchmark_year)
    AND (scope3_year IS NULL OR scope3_year > benchmark_year)),
  -- Net zero is the further, deeper commitment; it cannot precede or undercut the near-term one.
  CONSTRAINT client_targets_net_zero_after_near_term CHECK (
    net_zero_year IS NULL OR near_term_year IS NULL OR (net_zero_year >= near_term_year AND net_zero_pct >= near_term_pct)),
  -- A restatement onto a moved benchmark is a deliberate, reasoned act.
  CONSTRAINT client_targets_restatement_reason CHECK (NOT restated_benchmark OR reason IS NOT NULL)
);
CREATE INDEX client_targets_current_idx ON nzi_console.client_targets (organisation_id, client_id, version DESC);

ALTER TABLE nzi_console.client_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_targets
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
-- Append-only: a change is a new version, never an edit of the one before it.
GRANT SELECT, INSERT ON nzi_console.client_targets TO nzi_console_app;
REVOKE UPDATE, DELETE ON nzi_console.client_targets FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

-- Carry the forward targets already on the client record across as version 1, stamped
-- with the benchmark those clients are measured against. A client with targets but no
-- baseline is skipped: there is nothing to measure a percentage against, and the editor
-- asks for a baseline first rather than inventing one. The legacy columns stay for
-- history; the target model is the source from here.
INSERT INTO nzi_console.client_targets (
  organisation_id, client_id, version,
  net_zero_year, net_zero_pct, scope1_year, scope1_pct, scope2_year, scope2_pct, scope3_year, scope3_pct,
  benchmark_year, benchmark_total_tco2e, benchmark_scope1_tco2e, benchmark_scope2_tco2e, benchmark_scope3_tco2e,
  benchmark_source, benchmark_ref, reason, set_by, correlation_id)
SELECT c.organisation_id, c.client_id, 1,
  c.net_zero_target_year, c.net_zero_target_reduction_pct,
  c.scope1_interim_year, c.scope1_interim_reduction_pct,
  c.scope2_interim_year, c.scope2_interim_reduction_pct,
  c.scope3_interim_year, c.scope3_interim_reduction_pct,
  extract(year from c.baseline_period_start)::int,
  coalesce(c.baseline_total_tco2e, coalesce(c.baseline_scope1_tco2e,0) + coalesce(c.baseline_scope2_tco2e,0) + coalesce(c.baseline_scope3_tco2e,0)),
  c.baseline_scope1_tco2e, c.baseline_scope2_tco2e, c.baseline_scope3_tco2e,
  'client-record', 'migrated from the client record', 'Carried across from the client record by migration 0069.',
  'migration:0069', 'migration:0069'
FROM nzi_console.clients c
WHERE c.baseline_period_start IS NOT NULL
  AND coalesce(c.baseline_total_tco2e, c.baseline_scope1_tco2e, c.baseline_scope2_tco2e, c.baseline_scope3_tco2e) IS NOT NULL
  AND (c.net_zero_target_year IS NOT NULL OR c.scope1_interim_year IS NOT NULL OR c.scope2_interim_year IS NOT NULL OR c.scope3_interim_year IS NOT NULL)
  -- Only what the new record can hold honestly: a year and its percentage together, after the benchmark.
  AND (c.net_zero_target_year IS NULL OR (c.net_zero_target_reduction_pct IS NOT NULL AND c.net_zero_target_year > extract(year from c.baseline_period_start)::int))
  AND (c.scope1_interim_year IS NULL OR (c.scope1_interim_reduction_pct IS NOT NULL AND c.scope1_interim_year > extract(year from c.baseline_period_start)::int))
  AND (c.scope2_interim_year IS NULL OR (c.scope2_interim_reduction_pct IS NOT NULL AND c.scope2_interim_year > extract(year from c.baseline_period_start)::int))
  AND (c.scope3_interim_year IS NULL OR (c.scope3_interim_reduction_pct IS NOT NULL AND c.scope3_interim_year > extract(year from c.baseline_period_start)::int));

COMMIT;
