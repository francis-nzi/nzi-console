-- 0222 CRM tasks (BRIEF-crm-control-room-p3-tasks, ruled 10 Nov): the staff to-do list behind the Control Room's My tasks.
--
-- A task is a **standalone, internal** record — assigned to a member of staff, optionally about a job and/or a client, never
-- client-facing and never in a report. It is not a reduction action: the client's decarbonisation plan stays in
-- `client_strategies`, whose due dates the Control Room surfaces on their own.
--
-- - **Who:** `assigned_user_id` is an active member of the organisation (checked by the command; the key keeps it one of the
--   organisation's members). `created_by` is who wrote it — the creator and the assignee are the two who may change it
--   (access.ts).
-- - **About what:** `job_id` and/or `client_id`. A task on a job carries the job's client, set by the command, so a job and a
--   client can never disagree.
-- - **State:** `open` or `done`. Done, never deleted: a completed task is part of the record of the work, and nobody holds
--   DELETE. `completed_at` / `completed_by` are set exactly when it is done.
-- - **Versioned and audited:** every command bumps `version` against an expected version and writes an audit event by the
--   task's id (the runner's own).
BEGIN;

CREATE TABLE nzi_console.crm_tasks (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  task_id text NOT NULL,
  assigned_user_id text NOT NULL,
  job_id text,
  client_id text,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 4000),
  due_date date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  completed_at timestamptz,
  completed_by text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  PRIMARY KEY (organisation_id, task_id),
  FOREIGN KEY (organisation_id, assigned_user_id) REFERENCES nzi_console.memberships (organisation_id, user_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs (organisation_id, job_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients (organisation_id, client_id),
  CONSTRAINT crm_tasks_done_is_completed CHECK ((status = 'done') = (completed_at IS NOT NULL) AND (completed_at IS NULL) = (completed_by IS NULL)),
  CONSTRAINT crm_tasks_job_has_client CHECK (job_id IS NULL OR client_id IS NOT NULL)
);
COMMENT ON TABLE nzi_console.crm_tasks IS
  'CRM tasks (0222): internal staff to-dos, assigned to a member of staff, optionally on a job and/or client. Never client-facing, never in a report; done, never deleted.';

-- My tasks: one CRM's open tasks, by due date.
CREATE INDEX crm_tasks_open_by_assignee_idx ON nzi_console.crm_tasks (organisation_id, assigned_user_id, due_date) WHERE status = 'open';

ALTER TABLE nzi_console.crm_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.crm_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.crm_tasks
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.crm_tasks TO nzi_console_app;
REVOKE DELETE ON nzi_console.crm_tasks FROM nzi_console_app, PUBLIC;

COMMIT;
