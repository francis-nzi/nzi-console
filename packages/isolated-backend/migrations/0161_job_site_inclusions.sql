BEGIN;

-- Redesign Phase 3a (ruled 8 Oct 2026: JOB-REDESIGN-phase3-kickoff.md §3a, RULING-phase3-design.md #1–6) — which of the
-- client's sites a job reports on (JW-7).
--
-- Until now every in-use site of the client was in every job's report; the Phase 2 Sites drawer said so ("all included").
-- A job may now leave a site out. The decision is the job's, one per (job, site), with a reason when it excludes.
--
-- Versioned and append-only, the Phase 1 shape (0158): a change writes the next version for that (job, site); the one
-- before stays readable; the current is the highest version. **Absence means included** — a job that leaves every site
-- in writes no rows, so there is nothing to backfill and every existing job reads exactly as before.
--
-- What the table does not say, because the command does:
-- - that the site is the job's client's (no foreign key can say "the same client" across jobs and client_sites);
-- - that an excluded site has no rows, sources or pending portal records in the job (SITE_IN_USE, ruled #4) — checked
--   under a lock on the job row, which every site-setting write shares (ruled #5), so it holds in the same transaction.
--
-- Payloads (NZC-120): ids, a boolean and a version. The reason travels as the command's reason, as every reasoned command's
-- does.

CREATE TABLE nzi_console.job_site_inclusions (
  organisation_id text NOT NULL,
  job_id text NOT NULL,
  site_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),

  included boolean NOT NULL,
  /* Why — required to exclude (the CHECK below); optional to include. */
  reason text CHECK (reason IS NULL OR (reason = btrim(reason) AND reason <> '')),
  decided_by text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text NOT NULL,

  PRIMARY KEY (organisation_id, job_id, site_id, version),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs (organisation_id, job_id),
  FOREIGN KEY (organisation_id, site_id) REFERENCES nzi_console.client_sites (organisation_id, site_id),
  -- Leaving a site out of a report says why.
  CONSTRAINT job_site_inclusions_exclusion_reason CHECK (included OR reason IS NOT NULL)
);
CREATE INDEX job_site_inclusions_current_idx ON nzi_console.job_site_inclusions (organisation_id, job_id, site_id, version DESC);

ALTER TABLE nzi_console.job_site_inclusions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.job_site_inclusions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.job_site_inclusions
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
-- Append-only: a change is a new version, never an edit of the one before it.
GRANT SELECT, INSERT ON nzi_console.job_site_inclusions TO nzi_console_app;
REVOKE UPDATE, DELETE ON nzi_console.job_site_inclusions FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

COMMIT;
