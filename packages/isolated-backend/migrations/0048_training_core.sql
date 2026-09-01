BEGIN;

-- Job-family model batch, Phase 0 — Training delivery engine core (NZC-055/056;
-- MODEL_FIDELITY_JOB_FAMILIES.md §3). Additive, inert until the training module
-- reads it. Follows the live nzi_pro 0046/0047: reusable products → job-linked
-- course runs → scheduled sessions → participant bookings → per-session
-- attendance. The run is the versioned reviewed unit (NZC-055).

CREATE TABLE nzi_console.training_products (
  organisation_id text NOT NULL,
  training_product_id text NOT NULL,
  product_code text,
  product_name text NOT NULL CHECK (nullif(trim(product_name), '') IS NOT NULL),
  description text NOT NULL DEFAULT '',
  default_hours numeric CHECK (default_hours IS NULL OR default_hours >= 0),
  default_delivery_mode text CHECK (default_delivery_mode IS NULL OR default_delivery_mode IN ('in_person','online','hybrid')),
  default_capacity integer CHECK (default_capacity IS NULL OR default_capacity > 0),
  default_min_attendees integer CHECK (default_min_attendees IS NULL OR default_min_attendees >= 0),
  certificate_policy text NOT NULL DEFAULT '',
  certificate_min_attendance_pct integer NOT NULL DEFAULT 80 CHECK (certificate_min_attendance_pct BETWEEN 0 AND 100),
  default_documents_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz,
  PRIMARY KEY (organisation_id, training_product_id)
);
CREATE INDEX training_products_active_idx ON nzi_console.training_products(organisation_id, is_active, lower(product_name));
ALTER TABLE nzi_console.training_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.training_products FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.training_products USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.training_products TO nzi_console_app;

CREATE TABLE nzi_console.training_course_runs (
  organisation_id text NOT NULL,
  course_run_id text NOT NULL,
  job_id text NOT NULL,
  training_product_id text,
  run_name text,
  course_code text,
  total_hours numeric CHECK (total_hours IS NULL OR total_hours >= 0),
  delivery_mode text NOT NULL DEFAULT 'in_person' CHECK (delivery_mode IN ('in_person','online','hybrid')),
  capacity integer CHECK (capacity IS NULL OR capacity > 0),
  min_attendees integer CHECK (min_attendees IS NULL OR min_attendees >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','delivering','complete','cancelled')),
  workflow_stage_key text NOT NULL DEFAULT 'setup' CHECK (workflow_stage_key IN ('setup','bookings','delivery','attendance','certificates','complete')),
  start_date date,
  end_date date,
  venue_name text,
  venue_address text,
  online_meeting_url text,
  online_meeting_id text,
  online_passcode text,
  notes text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved','rejected')),
  reviewed_version integer,
  reviewed_by text,
  reviewed_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz,
  PRIMARY KEY (organisation_id, course_run_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, training_product_id) REFERENCES nzi_console.training_products(organisation_id, training_product_id) ON DELETE SET NULL,
  CONSTRAINT training_run_reviewed_shape CHECK ((review_status = 'pending') = (reviewed_version IS NULL)),
  CONSTRAINT training_run_dates_ordered CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE INDEX training_course_runs_job_idx ON nzi_console.training_course_runs(organisation_id, job_id, status, start_date);
ALTER TABLE nzi_console.training_course_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.training_course_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.training_course_runs USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.training_course_runs TO nzi_console_app;

CREATE TABLE nzi_console.training_course_sessions (
  organisation_id text NOT NULL,
  session_id text NOT NULL,
  course_run_id text NOT NULL,
  session_title text,
  session_date date,
  start_time time,
  end_time time,
  session_hours numeric CHECK (session_hours IS NULL OR session_hours >= 0),
  delivery_mode text CHECK (delivery_mode IS NULL OR delivery_mode IN ('in_person','online','hybrid')),
  venue_name text,
  venue_address text,
  online_meeting_url text,
  online_passcode text,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','delivered','cancelled')),
  notes text NOT NULL DEFAULT '',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, session_id),
  FOREIGN KEY (organisation_id, course_run_id) REFERENCES nzi_console.training_course_runs(organisation_id, course_run_id) ON DELETE CASCADE
);
CREATE INDEX training_course_sessions_run_idx ON nzi_console.training_course_sessions(organisation_id, course_run_id, session_date, start_time);
ALTER TABLE nzi_console.training_course_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.training_course_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.training_course_sessions USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON nzi_console.training_course_sessions TO nzi_console_app;

CREATE TABLE nzi_console.training_bookings (
  organisation_id text NOT NULL,
  booking_id text NOT NULL,
  course_run_id text NOT NULL,
  client_id text,
  participant_type text NOT NULL DEFAULT 'external_individual' CHECK (participant_type IN ('external_individual','client_employee','internal','partner')),
  booking_source text NOT NULL DEFAULT 'manual' CHECK (booking_source IN ('manual','portal','entitlement','import')),
  person_name text NOT NULL CHECK (nullif(trim(person_name), '') IS NOT NULL),
  person_email text,
  person_phone text,
  billing_status text NOT NULL DEFAULT 'pending' CHECK (billing_status IN ('pending','invoiced','paid','free_place','waived')),
  attendance_status text NOT NULL DEFAULT 'booked' CHECK (attendance_status IN ('booked','waitlisted','attended','partial','no_show','cancelled')),
  consent_status text NOT NULL DEFAULT 'unknown' CHECK (consent_status IN ('unknown','granted','declined')),
  special_requirements text NOT NULL DEFAULT '',
  entitlement_id text,
  notes text NOT NULL DEFAULT '',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz,
  PRIMARY KEY (organisation_id, booking_id),
  FOREIGN KEY (organisation_id, course_run_id) REFERENCES nzi_console.training_course_runs(organisation_id, course_run_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id) ON DELETE SET NULL
);
CREATE INDEX training_bookings_run_idx ON nzi_console.training_bookings(organisation_id, course_run_id, attendance_status, lower(person_name));
CREATE INDEX training_bookings_entitlement_idx ON nzi_console.training_bookings(organisation_id, entitlement_id);
ALTER TABLE nzi_console.training_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.training_bookings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.training_bookings USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.training_bookings TO nzi_console_app;

CREATE TABLE nzi_console.training_session_attendance (
  organisation_id text NOT NULL,
  attendance_id text NOT NULL,
  session_id text NOT NULL,
  booking_id text NOT NULL,
  attendance_status text NOT NULL DEFAULT 'booked' CHECK (attendance_status IN ('booked','present','absent','excused')),
  attendance_minutes integer CHECK (attendance_minutes IS NULL OR attendance_minutes >= 0),
  notes text NOT NULL DEFAULT '',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  PRIMARY KEY (organisation_id, attendance_id),
  FOREIGN KEY (organisation_id, session_id) REFERENCES nzi_console.training_course_sessions(organisation_id, session_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, booking_id) REFERENCES nzi_console.training_bookings(organisation_id, booking_id) ON DELETE CASCADE,
  UNIQUE (organisation_id, session_id, booking_id)
);
CREATE INDEX training_session_attendance_session_idx ON nzi_console.training_session_attendance(organisation_id, session_id, attendance_status);
CREATE INDEX training_session_attendance_booking_idx ON nzi_console.training_session_attendance(organisation_id, booking_id);
ALTER TABLE nzi_console.training_session_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.training_session_attendance FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.training_session_attendance USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.training_session_attendance TO nzi_console_app;

COMMENT ON TABLE nzi_console.training_course_runs IS 'One delivery of a training product, linked to a job; the versioned reviewed unit (NZC-055). review_status bound to reviewed_version.';
COMMENT ON TABLE nzi_console.training_session_attendance IS 'Per session per booking; attendance_minutes drives the certificate policy check.';

COMMIT;
