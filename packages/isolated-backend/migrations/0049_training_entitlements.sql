BEGIN;

-- Job-family model batch, Phase 0 — the one real cross-family link:
-- CRP job → training free places (MODEL_FIDELITY_JOB_FAMILIES.md §5; NZC-055).
-- An entitlement row is the ONLY connection between the two families — there is
-- no hard FK from training_bookings to a CRP job. Transitions
-- (available → reserved → consumed) are atomic, guarded like allocate_job_sequence().
-- Plus training_certificates — content-hashed evidence issued off an attendance
-- policy check, the artefact a training report cites.

CREATE TABLE nzi_console.training_entitlements (
  organisation_id text NOT NULL,
  entitlement_id text NOT NULL,
  source_job_id text NOT NULL,
  source_job_number text NOT NULL,
  source_client_id text NOT NULL,
  entitlement_type text NOT NULL DEFAULT 'free_place' CHECK (entitlement_type IN ('free_place')),
  origin text NOT NULL DEFAULT 'quote' CHECK (origin IN ('quote','manual_grant')),
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','reserved','consumed','expired','revoked')),
  allocated_to_booking_id text,
  allocated_course_run_id text,
  reserved_at timestamptz,
  consumed_at timestamptz,
  expires_at timestamptz,
  granted_by text NOT NULL,
  grant_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  PRIMARY KEY (organisation_id, entitlement_id),
  FOREIGN KEY (organisation_id, source_job_id) REFERENCES nzi_console.jobs(organisation_id, job_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, source_client_id) REFERENCES nzi_console.clients(organisation_id, client_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, allocated_to_booking_id) REFERENCES nzi_console.training_bookings(organisation_id, booking_id) ON DELETE SET NULL,
  FOREIGN KEY (organisation_id, allocated_course_run_id) REFERENCES nzi_console.training_course_runs(organisation_id, course_run_id) ON DELETE SET NULL,
  CONSTRAINT training_entitlement_allocation_shape CHECK (
    (status IN ('available','expired','revoked')) = (allocated_to_booking_id IS NULL)
  ),
  CONSTRAINT training_entitlement_reserved_at_shape CHECK ((status = 'available') OR (status IN ('expired','revoked')) OR reserved_at IS NOT NULL),
  CONSTRAINT training_entitlement_consumed_at_shape CHECK ((status = 'consumed') = (consumed_at IS NOT NULL))
);
CREATE INDEX training_entitlements_source_idx ON nzi_console.training_entitlements(organisation_id, source_job_id, status);
CREATE INDEX training_entitlements_status_idx ON nzi_console.training_entitlements(organisation_id, status, expires_at);
-- one entitlement per booking (a place can't be consumed twice)
CREATE UNIQUE INDEX training_entitlements_one_per_booking_idx
  ON nzi_console.training_entitlements(organisation_id, allocated_to_booking_id)
  WHERE allocated_to_booking_id IS NOT NULL;
ALTER TABLE nzi_console.training_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.training_entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.training_entitlements USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.training_entitlements TO nzi_console_app;

-- The source job must be a CRP job — training never grants its own free places,
-- and no other family does. Enforced, not just documented (NZC-024 boundary).
CREATE FUNCTION nzi_console.enforce_training_entitlement_source_is_crp() RETURNS trigger
LANGUAGE plpgsql SET search_path = nzi_console, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM nzi_console.jobs j
    WHERE j.organisation_id = NEW.organisation_id
      AND j.job_id = NEW.source_job_id
      AND j.job_family = 'crp'
      AND j.client_id = NEW.source_client_id
  ) THEN
    RAISE EXCEPTION 'Training entitlement source job must be a CRP job for the same client' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER training_entitlement_source_is_crp
BEFORE INSERT OR UPDATE OF source_job_id, source_client_id ON nzi_console.training_entitlements
FOR EACH ROW EXECUTE FUNCTION nzi_console.enforce_training_entitlement_source_is_crp();

-- Atomic available → reserved. Row-locked + status-guarded like the job-number
-- allocator; a place can't be double-reserved by construction.
CREATE FUNCTION nzi_console.reserve_training_entitlement(
  p_organisation_id text, p_entitlement_id text, p_booking_id text, p_course_run_id text
) RETURNS text
LANGUAGE plpgsql SET search_path = nzi_console, pg_temp AS $$
DECLARE current_status text;
BEGIN
  SELECT status INTO current_status
  FROM nzi_console.training_entitlements
  WHERE organisation_id = p_organisation_id AND entitlement_id = p_entitlement_id
  FOR UPDATE;

  IF current_status IS NULL THEN
    RAISE EXCEPTION 'Training entitlement % not found', p_entitlement_id USING ERRCODE = 'no_data_found';
  END IF;
  IF current_status <> 'available' THEN
    RAISE EXCEPTION 'Training entitlement % is % , not available', p_entitlement_id, current_status USING ERRCODE = '55000';
  END IF;

  UPDATE nzi_console.training_entitlements
  SET status = 'reserved',
      allocated_to_booking_id = p_booking_id,
      allocated_course_run_id = p_course_run_id,
      reserved_at = now(),
      updated_at = now()
  WHERE organisation_id = p_organisation_id AND entitlement_id = p_entitlement_id;
  RETURN 'reserved';
END $$;

-- Atomic reserved → consumed (booking's attendance confirmed).
CREATE FUNCTION nzi_console.consume_training_entitlement(
  p_organisation_id text, p_entitlement_id text
) RETURNS text
LANGUAGE plpgsql SET search_path = nzi_console, pg_temp AS $$
DECLARE current_status text;
BEGIN
  SELECT status INTO current_status
  FROM nzi_console.training_entitlements
  WHERE organisation_id = p_organisation_id AND entitlement_id = p_entitlement_id
  FOR UPDATE;

  IF current_status IS NULL THEN
    RAISE EXCEPTION 'Training entitlement % not found', p_entitlement_id USING ERRCODE = 'no_data_found';
  END IF;
  IF current_status <> 'reserved' THEN
    RAISE EXCEPTION 'Training entitlement % is % , not reserved', p_entitlement_id, current_status USING ERRCODE = '55000';
  END IF;

  UPDATE nzi_console.training_entitlements
  SET status = 'consumed', consumed_at = now(), updated_at = now()
  WHERE organisation_id = p_organisation_id AND entitlement_id = p_entitlement_id;
  RETURN 'consumed';
END $$;

GRANT EXECUTE ON FUNCTION nzi_console.enforce_training_entitlement_source_is_crp() TO nzi_console_app;
GRANT EXECUTE ON FUNCTION nzi_console.reserve_training_entitlement(text, text, text, text) TO nzi_console_app;
GRANT EXECUTE ON FUNCTION nzi_console.consume_training_entitlement(text, text) TO nzi_console_app;

-- Now that entitlements exist, tie the booking's free-place reference to a real row.
ALTER TABLE nzi_console.training_bookings
  ADD CONSTRAINT training_booking_entitlement_fk
  FOREIGN KEY (organisation_id, entitlement_id)
  REFERENCES nzi_console.training_entitlements(organisation_id, entitlement_id) ON DELETE SET NULL;
ALTER TABLE nzi_console.training_bookings
  ADD CONSTRAINT training_booking_entitlement_billing CHECK (
    entitlement_id IS NULL OR billing_status IN ('free_place','waived')
  );

CREATE TABLE nzi_console.training_certificates (
  organisation_id text NOT NULL,
  certificate_id text NOT NULL,
  course_run_id text NOT NULL,
  booking_id text NOT NULL,
  certificate_number text NOT NULL,
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','revoked','superseded')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  supersedes_certificate_id text,
  attended_minutes integer NOT NULL CHECK (attended_minutes >= 0),
  required_minutes integer NOT NULL CHECK (required_minutes >= 0),
  attendance_pct numeric NOT NULL CHECK (attendance_pct >= 0),
  policy_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  certificate_hash text NOT NULL CHECK (nullif(trim(certificate_hash), '') IS NOT NULL),
  storage_provider text CHECK (storage_provider IS NULL OR storage_provider IN ('local','sharepoint')),
  storage_url text,
  issued_by text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  revoked_by text,
  revoked_at timestamptz,
  revoke_reason text,
  PRIMARY KEY (organisation_id, certificate_id),
  FOREIGN KEY (organisation_id, course_run_id) REFERENCES nzi_console.training_course_runs(organisation_id, course_run_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, booking_id) REFERENCES nzi_console.training_bookings(organisation_id, booking_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, supersedes_certificate_id) REFERENCES nzi_console.training_certificates(organisation_id, certificate_id) ON DELETE SET NULL,
  CONSTRAINT training_certificate_revoked_shape CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT training_certificate_number_unique UNIQUE (organisation_id, certificate_number)
);
-- at most one live certificate per booking
CREATE UNIQUE INDEX training_certificates_one_active_per_booking_idx
  ON nzi_console.training_certificates(organisation_id, booking_id)
  WHERE status = 'issued';
CREATE INDEX training_certificates_run_idx ON nzi_console.training_certificates(organisation_id, course_run_id, status);
ALTER TABLE nzi_console.training_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.training_certificates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.training_certificates USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.training_certificates TO nzi_console_app;

COMMENT ON TABLE nzi_console.training_entitlements IS 'CRP → Training free places (NZC-055). The ONLY cross-family link; no hard FK from bookings to CRP jobs. available → reserved → consumed transitions are atomic (reserve_/consume_training_entitlement).';
COMMENT ON TABLE nzi_console.training_certificates IS 'Content-hashed attendance certificate; one active (status=issued) per booking, reissue supersedes. Evidence a training report cites.';

COMMIT;
