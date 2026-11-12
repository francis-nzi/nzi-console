-- 0229 The import workbench, Phase 3: each rehearsal and ingest of a job, kept to be seen (BRIEF-v7-import-workbench-phase3).
--
-- ## Why
--
-- Phase 3 ingests a job from its resolved decisions — revert → re-sync (0225) → re-plan → re-ingest (0166, D7 the floor) — run
-- on the operator's machine, which holds the one-job extract; the service never sees it (R-A option 1). The rehearsal runs the
-- whole chain first in one rolled-back transaction, so what it found leaves no trace unless it is recorded; the workbench shows
-- it, and the ingest that followed, from here. The re-sync and re-ingest keep their own run records (0225, 0166); this links
-- them to the summary and the decisions they ran from.
--
-- ## What it adds
--
--   - `v7_import_ingests`: one row per rehearsal (would commit, or refused — at which step, by which codes) and per ingest
--     (committed, with its re-sync and re-ingest runs). Each carries the summary it ran against, the extract, the decisions'
--     fingerprint and the plan's sha256, the re-sync's and the plan's counts, and Σ v7 and Σ live per scope as D7 reconciled them.
--     Ids, counts, codes and tCO2e only — a refusal's message can name a site, so only its codes are kept.
--
-- Written once, read after: SELECT and INSERT for the app, no UPDATE, no DELETE. Nothing here touches a job's rows.

BEGIN;

CREATE TABLE nzi_console.v7_import_ingests (
  organisation_id text NOT NULL,
  ingest_id text NOT NULL CHECK (ingest_id ~ '^v7-ingest-[0-9a-f-]{36}$'),
  job_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('rehearsal', 'ingest')),
  session_id text NOT NULL,
  extract_sha256 text NOT NULL CHECK (extract_sha256 ~ '^[0-9a-f]{64}$'),
  decisions_sha256 text NOT NULL CHECK (decisions_sha256 ~ '^[0-9a-f]{64}$'),
  plan_sha256 text CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('would-commit', 'refused', 'committed')),
  refused_stage text CHECK (refused_stage IN ('ready', 'revert', 'resync', 'replan', 'reingest')),
  refusal_codes text[] NOT NULL DEFAULT '{}' CHECK (cardinality(refusal_codes) <= 50 AND array_to_string(refusal_codes, ',') ~ '^([A-Z0-9_]{1,64}(,|$))*$'),
  rows_unchanged integer CHECK (rows_unchanged >= 0), rows_superseded integer CHECK (rows_superseded >= 0),
  rows_added integer CHECK (rows_added >= 0), rows_withdrawn integer CHECK (rows_withdrawn >= 0),
  plan_rows_committed integer CHECK (plan_rows_committed >= 0), plan_rows_decided integer CHECK (plan_rows_decided >= 0),
  v7_scope1_tco2e numeric, v7_scope2_tco2e numeric, v7_scope3_tco2e numeric,
  live_scope1_tco2e numeric, live_scope2_tco2e numeric, live_scope3_tco2e numeric,
  resync_run_id text CHECK (resync_run_id ~ '^v7-resync-[0-9a-f-]{36}$'),
  reingest_run_id text CHECK (reingest_run_id ~ '^v7-reingest-[0-9a-f-]{36}$'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text NOT NULL,
  PRIMARY KEY (organisation_id, ingest_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id),
  FOREIGN KEY (organisation_id, session_id) REFERENCES nzi_console.v7_import_sessions(organisation_id, session_id),
  FOREIGN KEY (organisation_id, resync_run_id) REFERENCES nzi_console.v7_resync_runs(organisation_id, run_id),
  FOREIGN KEY (organisation_id, reingest_run_id) REFERENCES nzi_console.v7_reingest_runs(organisation_id, run_id),
  -- A rehearsal would commit or was refused; an ingest committed, with both its runs. A refusal names its step and codes.
  CONSTRAINT v7_import_ingests_shape CHECK (CASE kind
    WHEN 'ingest' THEN outcome = 'committed' AND resync_run_id IS NOT NULL AND reingest_run_id IS NOT NULL
    ELSE outcome IN ('would-commit', 'refused') AND resync_run_id IS NULL AND reingest_run_id IS NULL END),
  CONSTRAINT v7_import_ingests_refusal CHECK ((outcome = 'refused') = (refused_stage IS NOT NULL) AND (outcome = 'refused') = (cardinality(refusal_codes) > 0)),
  -- Σ per scope is there exactly when D7 reconciled: a rehearsal that would commit, or the ingest.
  CONSTRAINT v7_import_ingests_totals CHECK ((outcome <> 'refused') = (v7_scope1_tco2e IS NOT NULL AND v7_scope2_tco2e IS NOT NULL AND v7_scope3_tco2e IS NOT NULL
    AND live_scope1_tco2e IS NOT NULL AND live_scope2_tco2e IS NOT NULL AND live_scope3_tco2e IS NOT NULL))
);
CREATE INDEX v7_import_ingests_job_idx ON nzi_console.v7_import_ingests (organisation_id, job_id, created_at DESC);

COMMENT ON TABLE nzi_console.v7_import_ingests IS
  'The import workbench''s rehearsals and ingests of a job (0229): the summary, extract and decisions each ran from, its outcome, counts, refusal codes and Σ tCO2e per scope. No label, quantity or message text. Read-only once written.';

ALTER TABLE nzi_console.v7_import_ingests ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.v7_import_ingests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.v7_import_ingests
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

-- Written once, read after. Never updated, never deleted.
GRANT SELECT, INSERT ON nzi_console.v7_import_ingests TO nzi_console_app;
REVOKE UPDATE, DELETE, TRUNCATE ON nzi_console.v7_import_ingests FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

COMMIT;
