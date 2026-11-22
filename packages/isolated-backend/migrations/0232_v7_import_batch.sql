-- 0232 The import, server-side, Phase E: the batch (BRIEF-v7-import-server-side-phase-e, R-5; RULING-v7-import-phase-e-infra §2).
--
-- A batch runs the Phase D fast path over every imported job of ONE client: the eligible auto-commit (each through import.refresh,
-- every Phase B/D guard), the rest are queued for a person. These two tables are its record — resumable, auditable, and the
-- review queue reads them. Nothing here is a new way to commit.
--
--   * v7_import_batch_runs: one per batch. One OPEN run (queued or running) per client, by a partial unique index. The runner is
--     in-process on the console service and holds the run by a lease (lease_holder, lease_until), renewed per job: one runner per
--     run. A run whose lease expired (a deploy, a crash) waits for an Admin's Resume. No stored counters: the tally is derived
--     from the results, so it cannot drift.
--   * v7_import_batch_results: one row per (run, job), written when the run starts, the client's jobs frozen in `position` order.
--     `because` and `flagged` are the fast path's own verdict, copied — not a new judgement. `refusal_codes` are a refusal's
--     codes; `failure_class` is a class, never a message. `attempts` counts view-timeout retries only: the job's idempotency key
--     is (run, job, attempts), so a crash-resume re-claims the SAME key and a commit that landed before the crash replays.
--
-- Figure-free (no Σ: the queue links to the job's own refresh panel, which reads Σ live), no PII, no free text. Forced row-level
-- security with the tenant policy. The application role inserts and updates; nobody deletes — a run is the record of what ran.

BEGIN;

CREATE TABLE nzi_console.v7_import_batch_runs (
  organisation_id text NOT NULL,
  run_id text NOT NULL CHECK (run_id ~ '^v7-batch-[0-9a-f-]{36}$'),
  client_id text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'cancelled')),
  triggered_by text NOT NULL CHECK (btrim(triggered_by) <> ''),
  correlation_id text NOT NULL CHECK (btrim(correlation_id) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  lease_holder text CHECK (lease_holder IS NULL OR btrim(lease_holder) <> ''),
  lease_until timestamptz,
  PRIMARY KEY (organisation_id, run_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id),
  CONSTRAINT v7_import_batch_runs_lease CHECK ((lease_holder IS NULL) = (lease_until IS NULL)),
  -- A finished run holds no lease and says when it finished; an open one has not finished.
  CONSTRAINT v7_import_batch_runs_finished CHECK (CASE WHEN status IN ('completed', 'cancelled')
    THEN finished_at IS NOT NULL AND lease_holder IS NULL ELSE finished_at IS NULL END)
);

CREATE UNIQUE INDEX v7_import_batch_runs_one_open ON nzi_console.v7_import_batch_runs (organisation_id, client_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX v7_import_batch_runs_client ON nzi_console.v7_import_batch_runs (organisation_id, client_id, created_at DESC);

CREATE TABLE nzi_console.v7_import_batch_results (
  organisation_id text NOT NULL,
  run_id text NOT NULL,
  job_id text NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'refreshed', 'current', 'queued', 'refused', 'failed', 'skipped')),
  because text[] NOT NULL DEFAULT '{}' CHECK (because <@ ARRAY['issued-report', 'manual-edits', 'flagged', 'admin-commits']::text[]),
  flagged integer NOT NULL DEFAULT 0 CHECK (flagged >= 0),
  refusal_codes text[] NOT NULL DEFAULT '{}' CHECK (cardinality(refusal_codes) <= 50 AND array_to_string(refusal_codes, ',') ~ '^([A-Z0-9_]{1,64}(,|$))*$'),
  failure_class text CHECK (failure_class IN ('view-timeout', 'view-unavailable', 'plan-missing', 'internal')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until timestamptz,
  ingest_id text,
  audit_event_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, run_id, job_id),
  UNIQUE (organisation_id, run_id, position),
  FOREIGN KEY (organisation_id, run_id) REFERENCES nzi_console.v7_import_batch_runs(organisation_id, run_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id),
  FOREIGN KEY (organisation_id, ingest_id) REFERENCES nzi_console.v7_import_ingests(organisation_id, ingest_id),
  -- Each outcome carries exactly what says why: a queued job its blockers, a refusal its codes, a failure its class, a refresh
  -- its committed ingest. Only a running row is leased.
  CONSTRAINT v7_import_batch_results_shape CHECK (
    (status = 'queued') = (cardinality(because) > 0)
    AND (status = 'refused') = (cardinality(refusal_codes) > 0)
    AND (status = 'failed') = (failure_class IS NOT NULL)
    AND (status = 'refreshed') = (ingest_id IS NOT NULL)
    AND (status = 'running') = (lease_until IS NOT NULL)
    AND (status = 'queued' OR flagged = 0))
);

CREATE INDEX v7_import_batch_results_open ON nzi_console.v7_import_batch_results (organisation_id, run_id, position)
  WHERE status IN ('pending', 'running');

COMMENT ON TABLE nzi_console.v7_import_batch_runs IS
  'A batch refresh of one client''s imported jobs (0232, Phase E). One open run per client; leased by its in-process runner; the tally is derived from v7_import_batch_results.';
COMMENT ON TABLE nzi_console.v7_import_batch_results IS
  'One job of a batch (0232): the fast path''s verdict copied (because, flagged), a refusal''s codes or a failure''s class. Figure-free. skipped = already current locally, NOT re-verified against the previous system.';

ALTER TABLE nzi_console.v7_import_batch_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.v7_import_batch_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.v7_import_batch_runs
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

ALTER TABLE nzi_console.v7_import_batch_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.v7_import_batch_results FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.v7_import_batch_results
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

REVOKE ALL ON nzi_console.v7_import_batch_runs FROM PUBLIC;
REVOKE ALL ON nzi_console.v7_import_batch_results FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON nzi_console.v7_import_batch_runs TO nzi_console_app;
GRANT SELECT, INSERT, UPDATE ON nzi_console.v7_import_batch_results TO nzi_console_app;

COMMIT;
