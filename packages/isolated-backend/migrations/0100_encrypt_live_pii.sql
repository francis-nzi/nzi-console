-- 0100 Personal data at rest is ciphertext, and erasure is the loss of a key (NZC-117).
--
-- The foundational migration of the erasure workstream. It creates the key store, adds the columns
-- that hold ciphertext and searchable digests, and moves the constraints that used to depend on
-- reading an address in the clear. It does **not** encrypt anything: the backfill is a separate,
-- resumable step, because a migration that rewrites every personal field in one transaction is a
-- migration that cannot be run twice and cannot be watched while it runs.
--
-- Out of scope, deliberately and by ruling: snapshots and certificates. Those are frozen,
-- content-hashed artefacts and their treatment is counsel-gated (NZC-104 removed the plate from
-- new snapshots forward-only; the legacy fork is its own decision). Nothing here touches them.
--
-- ## Two mechanisms, because personal data is used two ways
--
-- **Display-only** fields — a phone number, an employer, a postcode — become ciphertext under the
-- subject's own key. Destroying that key makes every one of them unreadable at once.
--
-- **Operational** fields — the addresses a login resolves and a unique constraint enforces — keep
-- a **blind index** beside the ciphertext: a keyed HMAC of the same normalised string the old
-- constraint compared. Equal addresses give equal digests, and the digest reveals nothing without
-- the key. The lineage is `verify_certificate_attempts`, which counts against a salted hash so that
-- verifying a certificate leaves no address behind.
--
-- ## The constraints have to move, or encryption cannot begin
--
-- Four CHECKs assert that an address equals its own lower-cased, trimmed form. Ciphertext does not,
-- so those constraints reject the very thing this migration exists to store. They are dropped here,
-- and the guarantee they carried — that two people cannot share an address — moves to a unique
-- index on the digest, where it means the same thing and can still be enforced by the database.
--
-- `memberships_email_once_idx` was **partial** (`WHERE email IS NOT NULL`) and its replacement is
-- partial too: a digest is null for an absent address, so members without one do not collide.

BEGIN;

-- ── The key store ────────────────────────────────────────────────────────────────────
--
-- One data key per subject, wrapped by the master key and useless without it. Erasure nulls
-- `wrapped_key`: the row stays, because links and audit point at the subject and a dangling
-- pointer is worse than a superseded row, but what the key protected becomes unreadable.
CREATE TABLE nzi_console.data_subject_keys (
  organisation_id text NOT NULL,
  subject_id uuid NOT NULL,
  -- Null once shredded. That is the erasure — not the deletion of any personal data, but the
  -- destruction of the only thing that could read it.
  wrapped_key jsonb,
  key_version integer NOT NULL DEFAULT 1 CHECK (key_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  shredded_at timestamptz,
  shredded_by text,
  -- The tombstone: an erased subject is recorded as erased rather than vanishing, so a later
  -- request can be answered with "yes, and here is when" instead of silence.
  PRIMARY KEY (organisation_id, subject_id),
  FOREIGN KEY (organisation_id, subject_id) REFERENCES nzi_console.data_subjects(organisation_id, subject_id),
  CONSTRAINT data_subject_key_shred_shape
    CHECK ((wrapped_key IS NULL) = (shredded_at IS NOT NULL AND shredded_by IS NOT NULL))
);

COMMENT ON TABLE nzi_console.data_subject_keys IS
  'One encryption key per person, wrapped by the master key. Erasure nulls wrapped_key and records who did it and when: the ciphertext stays where it is and stops being readable, which is what makes erasure survivable for foreign keys and audit history.';
COMMENT ON COLUMN nzi_console.data_subject_keys.wrapped_key IS
  'Null means shredded. There is no recovery path, deliberately — including for us.';

ALTER TABLE nzi_console.data_subject_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.data_subject_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.data_subject_keys
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.data_subject_keys TO nzi_console_app;
REVOKE DELETE ON nzi_console.data_subject_keys FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

-- ── Ciphertext columns for display-only fields ───────────────────────────────────────
--
-- Added beside the plaintext rather than replacing it, so the backfill can run row by row and be
-- interrupted. The plaintext columns are dropped in a later migration, once every row is encrypted
-- and every reader has been repointed — dropping them here would make this migration the one that
-- breaks the application.
ALTER TABLE nzi_console.trainees
  ADD COLUMN phone_sealed jsonb,
  ADD COLUMN current_employer_name_sealed jsonb;
ALTER TABLE nzi_console.client_contacts
  ADD COLUMN job_title_sealed jsonb,
  ADD COLUMN phone_sealed jsonb;
ALTER TABLE nzi_console.training_bookings
  ADD COLUMN person_name_sealed jsonb,
  ADD COLUMN person_email_sealed jsonb,
  ADD COLUMN person_phone_sealed jsonb;
ALTER TABLE nzi_console.clients
  ADD COLUMN owner_name_sealed jsonb,
  ADD COLUMN contact_name_sealed jsonb,
  ADD COLUMN contact_email_sealed jsonb;
ALTER TABLE nzi_console.jobs ADD COLUMN owner_name_sealed jsonb;
ALTER TABLE nzi_console.lca_suppliers
  ADD COLUMN contact_name_sealed jsonb,
  ADD COLUMN contact_email_sealed jsonb;
ALTER TABLE nzi_console.report_versions
  ADD COLUMN signee_name_sealed jsonb,
  ADD COLUMN signee_job_title_sealed jsonb;
ALTER TABLE nzi_console.strategy_automation_log ADD COLUMN recipient_email_sealed jsonb;
ALTER TABLE nzi_console.portal_report_comments ADD COLUMN author_display_name_sealed jsonb;
ALTER TABLE nzi_console.client_sites
  ADD COLUMN address_lines_sealed jsonb,
  ADD COLUMN postcode_sealed jsonb;
ALTER TABLE nzi_console.job_scope_rows ADD COLUMN asset_identifier_sealed jsonb;
ALTER TABLE nzi_console.job_emission_sources ADD COLUMN detail_sealed jsonb;
ALTER TABLE nzi_console.memberships ADD COLUMN display_name_sealed jsonb;
ALTER TABLE nzi_console.portal_users ADD COLUMN display_name_sealed jsonb;
ALTER TABLE nzi_console.trainees ADD COLUMN full_name_sealed jsonb;
ALTER TABLE nzi_console.client_contacts ADD COLUMN full_name_sealed jsonb;

-- ── Blind indexes for the operational addresses ──────────────────────────────────────
--
-- One per operational column, holding the keyed digest of that column's own normalisation. Null
-- where the address is absent, which is what keeps a partial unique index partial.
ALTER TABLE nzi_console.staff_credentials ADD COLUMN email_bidx text;
ALTER TABLE nzi_console.portal_users ADD COLUMN email_bidx text;
ALTER TABLE nzi_console.trainees ADD COLUMN email_bidx text;
ALTER TABLE nzi_console.client_contacts ADD COLUMN email_bidx text;
ALTER TABLE nzi_console.memberships ADD COLUMN email_bidx text;
ALTER TABLE nzi_console.trainee_email_changes
  ADD COLUMN current_email_bidx text,
  ADD COLUMN new_email_bidx text;

COMMENT ON COLUMN nzi_console.trainees.email_bidx IS
  'Keyed HMAC of the normalised address: matchable without being readable. Nulled on erasure, so an erased person leaves no fingerprint a guessed address could confirm.';

-- Equality lookups — a login is one of these — need an index to stay a lookup rather than a scan.
CREATE INDEX staff_credentials_email_bidx_idx ON nzi_console.staff_credentials(organisation_id, email_bidx);
CREATE INDEX portal_users_email_bidx_idx ON nzi_console.portal_users(organisation_id, email_bidx);
CREATE INDEX client_contacts_email_bidx_idx ON nzi_console.client_contacts(organisation_id, email_bidx);
CREATE INDEX trainee_email_changes_bidx_idx ON nzi_console.trainee_email_changes(organisation_id, current_email_bidx);

-- ── The constraints that assumed a readable address ──────────────────────────────────
--
-- Dropped because ciphertext cannot satisfy them. What they protected is re-established below on
-- the digest, where it means the same thing.
ALTER TABLE nzi_console.staff_credentials DROP CONSTRAINT staff_credentials_email_normalized_check;
ALTER TABLE nzi_console.portal_users DROP CONSTRAINT portal_users_email_normalized_check;
ALTER TABLE nzi_console.trainees DROP CONSTRAINT trainees_personal_email_check;
ALTER TABLE nzi_console.trainee_email_changes DROP CONSTRAINT trainee_email_changes_new_email_check;
ALTER TABLE nzi_console.strategy_automation_log DROP CONSTRAINT strategy_automation_log_recipient_email_check;

-- Uniqueness, restated on the digest. Created now and enforced from now: the backfill fills
-- `email_bidx` for existing rows, and until it has, these admit nulls — which is correct, because a
-- row whose digest is not yet computed is not yet claiming an address.
CREATE UNIQUE INDEX staff_credentials_email_bidx_unique
  ON nzi_console.staff_credentials(organisation_id, email_bidx) WHERE email_bidx IS NOT NULL;
CREATE UNIQUE INDEX portal_users_email_bidx_unique
  ON nzi_console.portal_users(organisation_id, email_bidx) WHERE email_bidx IS NOT NULL;
CREATE UNIQUE INDEX trainees_email_bidx_unique
  ON nzi_console.trainees(organisation_id, email_bidx) WHERE email_bidx IS NOT NULL;
CREATE UNIQUE INDEX memberships_email_bidx_unique
  ON nzi_console.memberships(organisation_id, email_bidx) WHERE email_bidx IS NOT NULL;

COMMENT ON INDEX nzi_console.memberships_email_bidx_unique IS
  'Partial, exactly as memberships_email_once_idx was: a member with no address has a null digest and must not collide with every other member who has none.';

COMMIT;
