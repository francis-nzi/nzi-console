BEGIN;

CREATE SCHEMA IF NOT EXISTS nzi_console;
SET search_path TO nzi_console, public;

CREATE TABLE organisations (
  organisation_id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  organisation_id text NOT NULL REFERENCES organisations(organisation_id),
  user_id text NOT NULL,
  role_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','invited','suspended')),
  PRIMARY KEY (organisation_id, user_id)
);

CREATE TABLE clients (
  organisation_id text NOT NULL REFERENCES organisations(organisation_id),
  client_id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, client_id)
);

CREATE TABLE job_number_counter (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_sequence integer NOT NULL CHECK (last_sequence >= 0)
);
INSERT INTO job_number_counter(singleton, last_sequence) VALUES (true, 0);

CREATE FUNCTION allocate_job_sequence() RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nzi_console, pg_temp
AS $$
DECLARE allocated integer;
BEGIN
  UPDATE job_number_counter SET last_sequence = last_sequence + 1
  WHERE singleton = true RETURNING last_sequence INTO allocated;
  IF allocated > 999999 THEN RAISE EXCEPTION 'Job number capacity exhausted'; END IF;
  RETURN allocated;
END;
$$;

CREATE TABLE jobs (
  organisation_id text NOT NULL REFERENCES organisations(organisation_id),
  job_id text NOT NULL,
  client_id text NOT NULL,
  sequence integer NOT NULL UNIQUE CHECK (sequence BETWEEN 0 AND 999999),
  job_number text GENERATED ALWAYS AS ('J' || lpad(sequence::text, 6, '0')) STORED,
  job_family text NOT NULL CHECK (job_family IN ('crp','consultancy','lca','pcf','training')),
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','open','on-hold','complete','cancelled')),
  workflow_stage text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, job_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES clients(organisation_id, client_id),
  UNIQUE (organisation_id, job_number)
);

CREATE TABLE job_stage_history (
  organisation_id text NOT NULL,
  stage_event_id text NOT NULL,
  job_id text NOT NULL,
  from_stage text NOT NULL,
  to_stage text NOT NULL,
  actor_id text NOT NULL,
  note text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, stage_event_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES jobs(organisation_id, job_id)
);

CREATE TABLE job_scope_rows (
  organisation_id text NOT NULL,
  scope_row_id text NOT NULL,
  job_id text NOT NULL,
  scope text NOT NULL,
  source_label text NOT NULL,
  quantity numeric,
  unit text,
  dataset_id text,
  factor_id text,
  calculated_tco2e numeric,
  override_tco2e numeric,
  override_reason text,
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved','rejected')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (organisation_id, scope_row_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES jobs(organisation_id, job_id),
  CHECK (override_tco2e IS NULL OR nullif(trim(override_reason),'') IS NOT NULL)
);

CREATE TABLE report_versions (
  organisation_id text NOT NULL,
  report_version_id text NOT NULL,
  job_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','validated','published','superseded')),
  manifest_version integer NOT NULL CHECK (manifest_version > 0),
  reviewed_snapshot_id text NOT NULL,
  data_hash text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  PRIMARY KEY (organisation_id, report_version_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES jobs(organisation_id, job_id)
);

CREATE TABLE portal_access_grants (
  organisation_id text NOT NULL,
  grant_id text NOT NULL,
  client_id text NOT NULL,
  portal_user_id text NOT NULL,
  job_id text NOT NULL,
  data_entry_expires_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (organisation_id, grant_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES clients(organisation_id, client_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES jobs(organisation_id, job_id)
);

CREATE TABLE command_idempotency (
  organisation_id text NOT NULL REFERENCES organisations(organisation_id),
  idempotency_key text NOT NULL,
  command_key text NOT NULL,
  request_hash text NOT NULL,
  outcome_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, idempotency_key)
);

CREATE TABLE audit_events (
  organisation_id text NOT NULL REFERENCES organisations(organisation_id),
  audit_event_id text NOT NULL,
  actor_id text NOT NULL,
  principal_type text NOT NULL CHECK (principal_type IN ('staff','portal','system')),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  correlation_id text NOT NULL,
  reason text,
  before_json jsonb,
  after_json jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, audit_event_id)
);

CREATE TABLE transactional_outbox (
  organisation_id text NOT NULL REFERENCES organisations(organisation_id),
  outbox_id text NOT NULL,
  topic text NOT NULL,
  payload_json jsonb NOT NULL,
  correlation_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','sent','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, outbox_id)
);

CREATE INDEX jobs_client_idx ON jobs(organisation_id, client_id);
CREATE INDEX scope_rows_job_idx ON job_scope_rows(organisation_id, job_id);
CREATE INDEX audit_correlation_idx ON audit_events(organisation_id, correlation_id);
CREATE INDEX outbox_pending_idx ON transactional_outbox(organisation_id, state, available_at);

COMMIT;
