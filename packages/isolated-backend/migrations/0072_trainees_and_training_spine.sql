BEGIN;

-- Training, part 1 — the person-centric spine.
--
-- The load-bearing decision: a trainee is a PERSON, not an employer's contact. Training is
-- personal, it outlasts a job, and a certificate belongs to the individual who earned it.
-- So `trainees` is not owned by a client, its personal email is the login identity, and a
-- booking references a trainee_id while separately freezing the employer and funding
-- context that applied at the time.
--
-- That separation is what makes the "on leave" path honest: the person updates their own
-- details and their history travels with them, while the former employer keeps the record
-- of what it funded and loses sight of the person's new personal details. Changing an
-- email never rewrites who paid.

-- ── The person ───────────────────────────────────────────────────────────────────────

CREATE TABLE nzi_console.trainees (
  organisation_id text NOT NULL,
  trainee_id text NOT NULL,
  full_name text NOT NULL CHECK (nullif(trim(full_name), '') IS NOT NULL),
  /* The login identity, and changeable — hence normalised and unique, never a key. */
  personal_email text NOT NULL CHECK (personal_email = lower(trim(personal_email)) AND personal_email <> ''),
  phone text NOT NULL DEFAULT '',
  /* Where the person says they work now. Self-updatable, and deliberately NOT the
     attribution used for past training — that is frozen on each booking. */
  current_employer_client_id text,
  current_employer_name text NOT NULL DEFAULT '',
  marketing_consent text NOT NULL DEFAULT 'unknown' CHECK (marketing_consent IN ('unknown', 'granted', 'declined')),
  consent_version text NOT NULL DEFAULT '',
  consent_recorded_at timestamptz,
  /* Deactivate, never delete: a deactivated person keeps their history and their certificates. */
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'deactivated')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz,
  PRIMARY KEY (organisation_id, trainee_id),
  FOREIGN KEY (organisation_id, current_employer_client_id) REFERENCES nzi_console.clients(organisation_id, client_id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX trainees_email_idx ON nzi_console.trainees (organisation_id, personal_email);
CREATE INDEX trainees_employer_idx ON nzi_console.trainees (organisation_id, current_employer_client_id) WHERE current_employer_client_id IS NOT NULL;

ALTER TABLE nzi_console.trainees ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.trainees FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.trainees
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.trainees TO nzi_console_app;
REVOKE DELETE ON nzi_console.trainees FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

-- ── A booking belongs to a person, and freezes its own context ────────────────────────

ALTER TABLE nzi_console.training_bookings ADD COLUMN trainee_id text;
ALTER TABLE nzi_console.training_bookings
  ADD CONSTRAINT training_booking_trainee_fk
  FOREIGN KEY (organisation_id, trainee_id) REFERENCES nzi_console.trainees(organisation_id, trainee_id);
CREATE INDEX training_bookings_trainee_idx ON nzi_console.training_bookings (organisation_id, trainee_id);

-- Carry the people already recorded inline across into real trainee records, one per
-- distinct email (the same person booked twice is one person). A booking with no usable
-- email cannot be attributed to a person and keeps its inline detail until someone
-- reconciles it — inventing an identity would be worse than leaving it visible.
INSERT INTO nzi_console.trainees (organisation_id, trainee_id, full_name, personal_email, phone, created_by, created_at)
SELECT b.organisation_id,
  'trainee-' || md5(b.organisation_id || ':' || lower(trim(b.person_email))),
  min(b.person_name),
  lower(trim(b.person_email)),
  coalesce(min(nullif(trim(b.person_phone), '')), ''),
  'migration:0072', now()
FROM nzi_console.training_bookings b
WHERE nullif(trim(b.person_email), '') IS NOT NULL
GROUP BY b.organisation_id, lower(trim(b.person_email))
ON CONFLICT DO NOTHING;

UPDATE nzi_console.training_bookings b
SET trainee_id = 'trainee-' || md5(b.organisation_id || ':' || lower(trim(b.person_email)))
WHERE nullif(trim(b.person_email), '') IS NOT NULL;

COMMENT ON COLUMN nzi_console.training_bookings.client_id IS
  'The EMPLOYER at the time of booking — historical attribution, frozen. Never rewritten when the person moves on; the trainee''s current employer lives on trainees.current_employer_client_id.';
COMMENT ON COLUMN nzi_console.training_bookings.person_name IS
  'Inline name kept for bookings migrated before trainee_id existed, and for the audit trail of what was typed at the time. The trainee record is the identity.';

-- ── The trainee identity realm (third realm, mirroring the client portal) ─────────────
--
-- Same construction as portal_*: the app role can read the person but can never touch
-- credentials or sessions; only nzi_console_auth can. NZI never enters a user's password —
-- the trainee sets their own from an invitation, and enrols their own MFA.

CREATE TABLE nzi_console.trainee_credentials (
  organisation_id text NOT NULL,
  trainee_id text NOT NULL,
  password_salt text NOT NULL,
  password_hash text NOT NULL,
  totp_ciphertext text,
  totp_iv text,
  totp_tag text,
  enabled boolean NOT NULL DEFAULT false,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  last_login_at timestamptz,
  password_changed_at timestamptz,
  PRIMARY KEY (organisation_id, trainee_id),
  FOREIGN KEY (organisation_id, trainee_id) REFERENCES nzi_console.trainees(organisation_id, trainee_id) ON DELETE CASCADE
);

CREATE TABLE nzi_console.trainee_login_challenges (
  organisation_id text NOT NULL,
  challenge_id text NOT NULL,
  trainee_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, challenge_id),
  FOREIGN KEY (organisation_id, trainee_id) REFERENCES nzi_console.trainees(organisation_id, trainee_id) ON DELETE CASCADE
);

CREATE TABLE nzi_console.trainee_sessions (
  organisation_id text NOT NULL,
  session_id text NOT NULL,
  trainee_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, session_id),
  FOREIGN KEY (organisation_id, trainee_id) REFERENCES nzi_console.trainees(organisation_id, trainee_id) ON DELETE CASCADE
);

CREATE TABLE nzi_console.trainee_invitations (
  organisation_id text NOT NULL,
  invitation_id text NOT NULL,
  trainee_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  setup_started_at timestamptz,
  consumed_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, invitation_id),
  FOREIGN KEY (organisation_id, trainee_id) REFERENCES nzi_console.trainees(organisation_id, trainee_id) ON DELETE CASCADE
);

-- Changing the login email is a two-step act: the new address must be proved before it
-- becomes the sign-in. Until then the old email still signs in, so a typo cannot lock a
-- person out of their own record.
CREATE TABLE nzi_console.trainee_email_changes (
  organisation_id text NOT NULL,
  change_id text NOT NULL,
  trainee_id text NOT NULL,
  current_email text NOT NULL,
  new_email text NOT NULL CHECK (new_email = lower(trim(new_email)) AND new_email <> ''),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, change_id),
  FOREIGN KEY (organisation_id, trainee_id) REFERENCES nzi_console.trainees(organisation_id, trainee_id) ON DELETE CASCADE,
  CONSTRAINT trainee_email_change_settled_once CHECK (confirmed_at IS NULL OR cancelled_at IS NULL)
);
CREATE INDEX trainee_email_changes_open_idx ON nzi_console.trainee_email_changes (organisation_id, trainee_id) WHERE confirmed_at IS NULL AND cancelled_at IS NULL;

ALTER TABLE nzi_console.trainee_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.trainee_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.trainee_credentials
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
ALTER TABLE nzi_console.trainee_login_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.trainee_login_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.trainee_login_challenges
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
ALTER TABLE nzi_console.trainee_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.trainee_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.trainee_sessions
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
ALTER TABLE nzi_console.trainee_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.trainee_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.trainee_invitations
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
ALTER TABLE nzi_console.trainee_email_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.trainee_email_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.trainee_email_changes
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

-- Credentials and sessions belong to the auth role alone — the application role must not
-- be able to read a hash or forge a session, exactly as for the client portal.
REVOKE ALL ON nzi_console.trainee_credentials, nzi_console.trainee_login_challenges,
  nzi_console.trainee_sessions, nzi_console.trainee_invitations, nzi_console.trainee_email_changes
  FROM PUBLIC, nzi_console_app, nzi_console_worker;
GRANT SELECT, INSERT, UPDATE ON nzi_console.trainee_credentials TO nzi_console_auth;
GRANT SELECT, INSERT, UPDATE ON nzi_console.trainee_login_challenges TO nzi_console_auth;
GRANT SELECT, INSERT, UPDATE ON nzi_console.trainee_sessions TO nzi_console_auth;
GRANT SELECT, INSERT, UPDATE ON nzi_console.trainee_invitations TO nzi_console_auth;
GRANT SELECT, INSERT, UPDATE ON nzi_console.trainee_email_changes TO nzi_console_auth;
GRANT SELECT ON nzi_console.trainees TO nzi_console_auth;
-- The auth role activates a trainee once they finish enrolling, and is also how the person
-- maintains their own record: name, contact details, where they work now, and consent.
-- The column list is the boundary — `status` aside, nothing here touches a training fact.
-- A person can correct who they are; they cannot restate what they attended, who paid for
-- it, or which employer arranged it. Those live on bookings and snapshots and are not
-- reachable from this grant.
GRANT UPDATE (
  status, personal_email, full_name, phone,
  current_employer_client_id, current_employer_name,
  marketing_consent, consent_version, consent_recorded_at,
  version, updated_by, updated_at
) ON nzi_console.trainees TO nzi_console_auth;

-- The app role revokes a person's sessions without being able to write the table itself —
-- the same boundary-crossing shape as revoke_portal_user_sessions.
CREATE FUNCTION nzi_console.revoke_trainee_sessions(p_organisation_id text, p_trainee_id text, p_at timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = nzi_console, pg_temp AS $$
DECLARE revoked integer;
BEGIN
  IF p_organisation_id IS DISTINCT FROM current_setting('app.organisation_id', true) THEN
    RAISE EXCEPTION 'Cannot revoke trainee sessions outside the current organisation' USING ERRCODE = '42501';
  END IF;
  UPDATE nzi_console.trainee_sessions
  SET revoked_at = coalesce(p_at, now())
  WHERE organisation_id = p_organisation_id AND trainee_id = p_trainee_id AND revoked_at IS NULL;
  GET DIAGNOSTICS revoked = ROW_COUNT;
  RETURN revoked;
END $$;
GRANT EXECUTE ON FUNCTION nzi_console.revoke_trainee_sessions(text, text, timestamptz) TO nzi_console_app;

-- ── Entitlement expiry: default from the granting job, and movable ────────────────────
--
-- An expiry that nobody set is different from one somebody chose, and the client portal
-- has to be able to say which. The flag makes "moved" legible instead of inferred.

ALTER TABLE nzi_console.training_entitlements
  ADD COLUMN default_from_job_end boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN nzi_console.training_entitlements.default_from_job_end IS
  'True while expires_at is the granting job''s end date (the default). Set false when the CRM deliberately moves it, so "moved" and "default" are distinguishable.';

-- Backfill: places already granted take their granting job's end date, marked as the
-- default, unless someone had already set one.
UPDATE nzi_console.training_entitlements e
SET expires_at = (j.due_date + time '23:59:59') AT TIME ZONE 'UTC',
    default_from_job_end = true,
    updated_at = now()
FROM nzi_console.jobs j
WHERE (j.organisation_id, j.job_id) = (e.organisation_id, e.source_job_id)
  AND e.expires_at IS NULL
  AND j.due_date IS NOT NULL;

-- ── The run's own stage machine ───────────────────────────────────────────────────────
--
-- Three different vocabularies existed for this: the job spine's five stages, this
-- column's six, and the six in the confirmed brief. One of them has to win, and it is the
-- brief. The tables hold no delivered data yet, so the values are remapped rather than
-- carried, and the run stage stays distinct from the JOB stage (a job is the engagement,
-- a run is one delivery of a course).

ALTER TABLE nzi_console.training_course_runs DROP CONSTRAINT IF EXISTS training_course_runs_workflow_stage_key_check;
UPDATE nzi_console.training_course_runs SET workflow_stage_key = CASE workflow_stage_key
  WHEN 'setup' THEN 'planned'
  WHEN 'bookings' THEN 'scheduled'
  WHEN 'delivery' THEN 'in_delivery'
  WHEN 'attendance' THEN 'delivered'
  WHEN 'certificates' THEN 'certified'
  WHEN 'complete' THEN 'reviewed'
  ELSE 'planned' END;
ALTER TABLE nzi_console.training_course_runs
  ADD CONSTRAINT training_course_runs_workflow_stage_key_check
  CHECK (workflow_stage_key IN ('planned', 'scheduled', 'in_delivery', 'delivered', 'certified', 'reviewed'));

-- ── The reviewed run snapshot ─────────────────────────────────────────────────────────
--
-- Reviewing a run freezes its attendance register and issued certificates into one
-- content-addressed payload, and the family report, the client portal and the trainee
-- portal all read that — they recompute nothing. Same hash discipline as the CRP and LCA
-- snapshots, and immutable by construction: no UPDATE, no DELETE.

CREATE TABLE nzi_console.training_run_snapshots (
  organisation_id text NOT NULL,
  snapshot_id text NOT NULL,
  course_run_id text NOT NULL,
  job_id text NOT NULL,
  snapshot_version integer NOT NULL CHECK (snapshot_version > 0),
  run_version integer NOT NULL CHECK (run_version > 0),
  data_hash text NOT NULL CHECK (nullif(trim(data_hash), '') IS NOT NULL),
  payload_json jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, snapshot_id),
  FOREIGN KEY (organisation_id, course_run_id) REFERENCES nzi_console.training_course_runs(organisation_id, course_run_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id) ON DELETE CASCADE,
  UNIQUE (organisation_id, course_run_id, snapshot_version)
);
CREATE INDEX training_run_snapshots_run_idx ON nzi_console.training_run_snapshots (organisation_id, course_run_id, snapshot_version DESC);
CREATE UNIQUE INDEX training_run_snapshots_hash_idx ON nzi_console.training_run_snapshots (organisation_id, course_run_id, data_hash);

ALTER TABLE nzi_console.training_run_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.training_run_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.training_run_snapshots
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT ON nzi_console.training_run_snapshots TO nzi_console_app;
REVOKE UPDATE, DELETE ON nzi_console.training_run_snapshots FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

-- ── Public certificate verification ──────────────────────────────────────────────────
--
-- A certificate is worth more if a future employer can confirm it without an account. The
-- verify code is separate from the certificate number: the number is the organisation's
-- own reference and is guessable by design, whereas this is what gets published, so it
-- carries enough entropy that certificates cannot be enumerated.

ALTER TABLE nzi_console.training_certificates ADD COLUMN verify_code text;
UPDATE nzi_console.training_certificates
SET verify_code = 'NZI-' || upper(substr(md5(certificate_id || certificate_hash), 1, 10))
WHERE verify_code IS NULL;
ALTER TABLE nzi_console.training_certificates ALTER COLUMN verify_code SET NOT NULL;
CREATE UNIQUE INDEX training_certificates_verify_code_idx ON nzi_console.training_certificates (verify_code);
COMMENT ON COLUMN nzi_console.training_certificates.verify_code IS
  'The public verification id. Published on the certificate and its QR; the verify page shows name, course, date, issuer and validity — never contact details. Revoking the certificate makes the page say so rather than removing it.';

-- ── Public verification, bounded by construction ─────────────────────────────────────
--
-- Verification is the one read with no session behind it: a future employer holding a
-- certificate must be able to confirm it without an account, and therefore without a
-- tenant context. That is exactly why it goes through a SECURITY DEFINER function rather
-- than a query the app could widen later — the function IS the contract for what public
-- verification can ever return.
--
-- It returns the person's name, the course, the date, the issuer and the standing. It
-- cannot return an email, an employer, a person's other training, or anything about the
-- client who paid. A wrong code returns no row, not a hint about which part was wrong.

CREATE FUNCTION nzi_console.verify_training_certificate(p_verify_code text)
RETURNS TABLE (
  person_name text, course_name text, completed_on date, attendance_pct numeric,
  certificate_number text, issued_on date, status text, revoked_on date, issuer text
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = nzi_console, pg_temp AS $$
  SELECT b.person_name,
         coalesce(p.product_name, r.run_name, 'Training'),
         (SELECT max(s.session_date) FROM nzi_console.training_course_sessions s
           WHERE (s.organisation_id, s.course_run_id) = (r.organisation_id, r.course_run_id) AND s.status = 'delivered'),
         c.attendance_pct,
         c.certificate_number,
         c.issued_at::date,
         c.status,
         c.revoked_at::date,
         'Net Zero International'
  FROM nzi_console.training_certificates c
  JOIN nzi_console.training_bookings b ON (b.organisation_id, b.booking_id) = (c.organisation_id, c.booking_id)
  JOIN nzi_console.training_course_runs r ON (r.organisation_id, r.course_run_id) = (c.organisation_id, c.course_run_id)
  LEFT JOIN nzi_console.training_products p ON (p.organisation_id, p.training_product_id) = (r.organisation_id, r.training_product_id)
  WHERE c.verify_code = p_verify_code;
$$;
GRANT EXECUTE ON FUNCTION nzi_console.verify_training_certificate(text) TO nzi_console_app;
COMMENT ON FUNCTION nzi_console.verify_training_certificate(text) IS
  'Public certificate verification: the only tenant-crossing read in the training spine, and deliberately a function so its return list is the whole contract. Name, course, date, attendance, issuer and standing — never contact details, employer, or a person''s other training.';

-- ── How long a certificate stands for ────────────────────────────────────────────────
--
-- Some training expires and some does not, and only the product knows which. Left NULL,
-- a certificate is treated as standing indefinitely — so the client portal's skills view
-- can say "holds this" without inventing a refresher date nobody agreed. A refresher is
-- only ever shown where a validity was actually set.

ALTER TABLE nzi_console.training_products
  ADD COLUMN certificate_valid_months integer CHECK (certificate_valid_months IS NULL OR certificate_valid_months > 0);
COMMENT ON COLUMN nzi_console.training_products.certificate_valid_months IS
  'How long this training stands for, in months. NULL means it does not lapse — never a default of "one year", which would put a refresher date on every record whether or not one was agreed.';

COMMENT ON TABLE nzi_console.trainees IS
  'A person who has trained, independent of any employer (the load-bearing decision). Personal email is the changeable login identity; history aggregates per person. Employer attribution lives on each booking and is never rewritten.';
COMMENT ON TABLE nzi_console.training_run_snapshots IS
  'Content-addressed reviewed run: the frozen attendance register and issued certificates the family report and both portals read. Immutable — a change is a new snapshot.';

COMMIT;
