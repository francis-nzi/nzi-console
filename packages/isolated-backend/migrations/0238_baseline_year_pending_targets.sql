-- 0238 A baseline year before its figures, and targets set as percentages while they are pending
-- (BRIEF-baseline-year-and-pending-targets.md; ruled by Francis 25 Nov 2026, from the v7-client-377 run-through).
--
-- The baseline stays where it is: the six `baseline_*` columns on `nzi_console.clients` (0060), read through the one seam
-- `getBenchmarkInForce` (the `client_baselines` record, #137, is still unmerged). A period with no figures is already
-- storable there; it was simply read as "No baseline". What could not be stored:
--
--   1. A target against a pending baseline. `client_targets` stamps the benchmark each version was set against, and its total
--      was NOT NULL. The percentage is the record; the tCO2e is derived from the benchmark, never stored as if it had been
--      entered. So a version set while the baseline is pending stamps the year and `benchmark_pending`, with no figures.
--      Once the baseline has figures for that year the readers derive the tCO2e from the baseline in force (not stale: figures
--      arriving is not a re-baseline). A version is pending exactly when it has no total, and then it has no scope figures.
--   2. An intensity target against a pending baseline intensity. `baseline_intensity` was NOT NULL; null now means pending
--      (worked out from the baseline's figures and the baseline year's metric value when both exist, at read time).
--   3. The link from a baseline to the reviewed snapshot that supplied its figures ("Use J… figures as the baseline"). One
--      nullable column on the client, naming a reviewed CRP snapshot of the same organisation; a baseline citing a snapshot
--      has figures. Cleared by any hand edit of the baseline (client.update), set only by client.baseline.useSnapshot.
--
-- No backfill: every existing row already satisfies the new checks (pending = false, totals present).

BEGIN;

-- ── 1. Targets against a pending benchmark ──────────────────────────────────────────────────────────────────────────
ALTER TABLE nzi_console.client_targets
  ALTER COLUMN benchmark_total_tco2e DROP NOT NULL,
  ADD COLUMN benchmark_pending boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT client_targets_benchmark_pending CHECK (
    benchmark_pending = (benchmark_total_tco2e IS NULL)
    AND (NOT benchmark_pending OR (benchmark_scope1_tco2e IS NULL AND benchmark_scope2_tco2e IS NULL AND benchmark_scope3_tco2e IS NULL)));

-- ── 2. Intensity targets against a pending baseline intensity ───────────────────────────────────────────────────────
ALTER TABLE nzi_console.client_intensity_targets
  ALTER COLUMN baseline_intensity DROP NOT NULL;

-- ── 3. The snapshot a baseline's figures came from ──────────────────────────────────────────────────────────────────
ALTER TABLE nzi_console.clients
  ADD COLUMN baseline_snapshot_id text,
  ADD CONSTRAINT clients_baseline_snapshot_fk FOREIGN KEY (organisation_id, baseline_snapshot_id)
    REFERENCES nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id),
  ADD CONSTRAINT clients_baseline_snapshot_has_figures CHECK (
    baseline_snapshot_id IS NULL
    OR (baseline_period_start IS NOT NULL AND baseline_period_end IS NOT NULL AND baseline_total_tco2e IS NOT NULL));

-- ── 4. Job dates: who owns each, and what V7 last said (Addendum B, ruled 25 Nov 2026) ─────────────────────────────
-- A job's dates are editable in the console, imported jobs included. Once a date is edited here the console owns it: a later
-- sync records what V7 says but does not overwrite it, and the job shows the difference with "Use V7's dates" / "Keep the
-- console's". A date never edited here follows V7 on every sync. Both tables are append-only; the current owner of a date
-- is its latest row, and a date with no row is V7's (for an imported job).
--   date_key: 'start_date', 'reporting_period' (start and end move together), or 'milestone:<kind>' (a milestone's due date).
CREATE TABLE nzi_console.job_date_owners (
  organisation_id text NOT NULL,
  owner_no bigint GENERATED ALWAYS AS IDENTITY,
  job_id text NOT NULL,
  date_key text NOT NULL CHECK (date_key IN ('start_date', 'reporting_period') OR date_key ~ '^milestone:[a-z0-9_-]+$'),
  owner text NOT NULL CHECK (owner IN ('console', 'v7')),
  -- edited: a console edit · kept: "Keep the console's" (acknowledges the V7 value it was shown) · use-v7: "Use V7's dates".
  cause text NOT NULL CHECK (cause IN ('edited', 'kept', 'use-v7')),
  acknowledged_observation_no bigint,
  set_by text NOT NULL CHECK (btrim(set_by) <> ''),
  correlation_id text NOT NULL CHECK (btrim(correlation_id) <> ''),
  set_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, owner_no),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs (organisation_id, job_id),
  CONSTRAINT job_date_owners_cause CHECK ((owner = 'v7') = (cause = 'use-v7') AND (acknowledged_observation_no IS NULL OR cause = 'kept'))
);
CREATE INDEX job_date_owners_current_idx ON nzi_console.job_date_owners (organisation_id, job_id, date_key, owner_no DESC);

-- What V7 said a date was, each time a sync saw it change. Dates only — no figures, no person.
CREATE TABLE nzi_console.job_v7_date_observations (
  organisation_id text NOT NULL,
  observation_no bigint GENERATED ALWAYS AS IDENTITY,
  job_id text NOT NULL,
  date_key text NOT NULL CHECK (date_key IN ('start_date', 'reporting_period') OR date_key ~ '^milestone:[a-z0-9_-]+$'),
  v7_from date,
  v7_to date,
  run_id text NOT NULL CHECK (btrim(run_id) <> ''),
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, observation_no),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs (organisation_id, job_id),
  CONSTRAINT job_v7_date_observations_shape CHECK ((date_key = 'reporting_period') OR v7_to IS NULL)
);
CREATE INDEX job_v7_date_observations_latest_idx ON nzi_console.job_v7_date_observations (organisation_id, job_id, date_key, observation_no DESC);

ALTER TABLE nzi_console.job_date_owners ADD CONSTRAINT job_date_owners_acknowledged_fk
  FOREIGN KEY (organisation_id, acknowledged_observation_no) REFERENCES nzi_console.job_v7_date_observations (organisation_id, observation_no);

ALTER TABLE nzi_console.job_date_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.job_date_owners FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.job_date_owners
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
ALTER TABLE nzi_console.job_v7_date_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.job_v7_date_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.job_v7_date_observations
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
-- Append-only, for everyone.
GRANT SELECT, INSERT ON nzi_console.job_date_owners, nzi_console.job_v7_date_observations TO nzi_console_app;
REVOKE UPDATE, DELETE ON nzi_console.job_date_owners, nzi_console.job_v7_date_observations FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

COMMIT;
