-- 0195 Data entry D3 (R3, R4, R6): the persisted prior-job pick, carry-forward keyed by GL code, and a client's request to
-- reopen a reviewed entry (BUILD-dataentry-D3-pgs-specifics).
--
-- ## What is added
--
-- - **`job_carry_forward_basis`** (R3) — which prior job (and its period) this job carries forward from, stored the first time it
--   carries anything forward. Before this the prior job was recomputed on every read ("the latest earlier CRP job with spend"), so
--   a job created or re-dated later silently changed which year a job's carried lines were said to come from. Once stored it is
--   the basis: the previews read it and a carry-forward from another job is refused. Insert-only — no UPDATE, no DELETE.
-- - **`job_emission_sources.carry_key`** (R4) — a carried-forward spend line's identity: its GL code (`gl:7420`), or, with no GL
--   code, its normalised description (`description:pensions admin`), as the D2 allocation map keys a line. One carried line per
--   key per job, held by the unique index — so carrying forward twice, or concurrently, never carries a GL code twice, and a
--   re-import fills the carried line for its GL code instead of adding a second.
-- - **`scope_row_reopen_requests`** (R6) — after an entry is reviewed the client cannot change it, and there is no self-serve
--   recall: they ask. The request (with their reason) is recorded here and sent to the CRM as a message; the CRM reopens by editing
--   the entry, which returns it to pending and marks the request `reopened`. One open request per entry.
--
-- The reason is the client's own words about their entry — business data, held like a portal record's note. Tenant-isolated.

BEGIN;

CREATE TABLE nzi_console.job_carry_forward_basis (
  organisation_id text NOT NULL,
  job_id text NOT NULL,
  prior_job_id text NOT NULL CHECK (prior_job_id <> job_id),
  -- The prior job's period as it stood when chosen, so the basis says which year it was even if that job is re-dated later.
  prior_period_from date,
  prior_period_to date,
  chosen_by text NOT NULL CHECK (btrim(chosen_by) <> ''),
  chosen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, job_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id),
  FOREIGN KEY (organisation_id, prior_job_id) REFERENCES nzi_console.jobs(organisation_id, job_id),
  CHECK ((prior_period_from IS NULL) = (prior_period_to IS NULL))
);
COMMENT ON TABLE nzi_console.job_carry_forward_basis IS
  'D3 (R3): the prior job this job carries forward from, stored when first chosen and never recomputed. Insert-only.';

ALTER TABLE nzi_console.job_carry_forward_basis ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.job_carry_forward_basis FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.job_carry_forward_basis
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT ON nzi_console.job_carry_forward_basis TO nzi_console_app;
REVOKE UPDATE, DELETE ON nzi_console.job_carry_forward_basis FROM nzi_console_app, PUBLIC;

ALTER TABLE nzi_console.job_emission_sources
  ADD COLUMN carry_key text CHECK (carry_key IS NULL OR carry_key ~ '^(gl|description):.+$');
COMMENT ON COLUMN nzi_console.job_emission_sources.carry_key IS
  'D3 (R4): a carried-forward spend line''s identity — gl:<GL code>, or description:<normalised description> where it has none.';
CREATE UNIQUE INDEX job_emission_sources_one_carried_line_per_key_idx
  ON nzi_console.job_emission_sources (organisation_id, job_id, carry_key)
  WHERE carry_key IS NOT NULL AND voided_at IS NULL;

CREATE TABLE nzi_console.scope_row_reopen_requests (
  organisation_id text NOT NULL,
  request_id text NOT NULL,
  job_id text NOT NULL,
  scope_row_id text NOT NULL,
  -- The entry's version the client saw when asking.
  row_version integer NOT NULL CHECK (row_version > 0),
  portal_user_id text NOT NULL,
  reason text NOT NULL CHECK (btrim(reason) <> '' AND char_length(reason) <= 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reopened')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  -- The message to the CRM, when one could be sent (null: no adviser with an email on the job or client).
  email_message_id text,
  resolved_by text,
  resolved_at timestamptz,
  PRIMARY KEY (organisation_id, request_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id),
  FOREIGN KEY (organisation_id, scope_row_id) REFERENCES nzi_console.job_scope_rows(organisation_id, scope_row_id),
  FOREIGN KEY (organisation_id, portal_user_id) REFERENCES nzi_console.portal_users(organisation_id, portal_user_id),
  CHECK ((status = 'open') = (resolved_at IS NULL)),
  CHECK ((status = 'open') = (resolved_by IS NULL))
);
CREATE UNIQUE INDEX scope_row_reopen_requests_one_open_idx
  ON nzi_console.scope_row_reopen_requests (organisation_id, scope_row_id) WHERE status = 'open';
CREATE INDEX scope_row_reopen_requests_job_idx ON nzi_console.scope_row_reopen_requests (organisation_id, job_id, status);
COMMENT ON TABLE nzi_console.scope_row_reopen_requests IS
  'D3 (R6): a client''s request to reopen a reviewed entry, sent to the CRM as a message; reopened when the CRM edits the entry.';

ALTER TABLE nzi_console.scope_row_reopen_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.scope_row_reopen_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.scope_row_reopen_requests
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT ON nzi_console.scope_row_reopen_requests TO nzi_console_app;
-- A request is resolved, never rewritten: only its state and who resolved it change.
GRANT UPDATE (status, resolved_by, resolved_at) ON nzi_console.scope_row_reopen_requests TO nzi_console_app;
REVOKE DELETE ON nzi_console.scope_row_reopen_requests FROM nzi_console_app, PUBLIC;

COMMIT;
