-- 0196 Data entry D4 (R1, R8): a company vehicle's registration held only sealed, under the client's own key, with a client
-- opt-out (BUILD-dataentry-D4-company-vehicles; seal design ruled 28 Oct: a per-client vehicle key).
--
-- ## Why a client key, not a subject key
--
-- NZC-119 seals a person's data under that person's key and erases them by shredding it. A registration has no person in our
-- data — the keeper is not a subject (piiInventory: "a keeper who is not in our data") — so there is no subject key to seal it
-- under. It is sealed instead under a key **per client, for this purpose**, wrapped by the same master key: the envelope the
-- document content keys use (0135), held in a table of its own so a call site says which kind of key it holds.
--
-- ## What is added
--
-- - **`client_data_keys`** — one live key per client per purpose (`vehicle-registration`). Shredding nulls `wrapped_key` and
--   records who and when (the `data_subject_keys` shape): every registration the client's key sealed becomes unreadable. A
--   client that opts back in gets a new key; the shredded row stays as the record.
-- - **`asset_identifier_sealed`** on `job_emission_sources` (`job_scope_rows` has had one since 0100, never written) and
--   **`asset_identifier_bidx`** on both: the ciphertext, and a keyed digest of the normalised plate, scoped to the client, so the
--   same vehicle can be recognised year on year (D4 R6) without the plate ever being read back. The plaintext `asset_identifier`
--   of a vehicle row is cleared by the write that seals it, in the same transaction.
-- - **`clients.vehicle_registrations_opt_out`** — "don't hold our reg numbers": no registration is stored for the client's
--   vehicles at all, and a vehicle is identified by a name or fleet number instead. Setting it shreds the client's key and
--   clears every registration already held.
--
-- Only company vehicles are sealed: `asset_identifier` also holds a commuter's name (commuting) and an invoice date (spend
-- import), which are not registrations and are not touched here.

BEGIN;

CREATE TABLE nzi_console.client_data_keys (
  organisation_id text NOT NULL,
  key_id text NOT NULL,
  client_id text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('vehicle-registration')),
  -- Null once shredded: the ciphertext stays where it is and stops being readable.
  wrapped_key jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  shredded_at timestamptz,
  shredded_by text,
  PRIMARY KEY (organisation_id, key_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id),
  CONSTRAINT client_data_key_shred_shape CHECK ((wrapped_key IS NULL) = (shredded_at IS NOT NULL AND shredded_by IS NOT NULL))
);
-- One live key per client and purpose; shredded ones stay as the record.
CREATE UNIQUE INDEX client_data_keys_one_live_idx ON nzi_console.client_data_keys (organisation_id, client_id, purpose) WHERE shredded_at IS NULL;
COMMENT ON TABLE nzi_console.client_data_keys IS
  'D4: a data key per client per purpose (vehicle registrations), wrapped by the master key. Not a subject key: a registration names no person in our data. Shredding nulls wrapped_key; there is no recovery path.';

ALTER TABLE nzi_console.client_data_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_data_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_data_keys
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT ON nzi_console.client_data_keys TO nzi_console_app;
-- A key is shredded, never re-pointed: only the shred columns change.
GRANT UPDATE (wrapped_key, shredded_at, shredded_by) ON nzi_console.client_data_keys TO nzi_console_app;
REVOKE DELETE ON nzi_console.client_data_keys FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

ALTER TABLE nzi_console.job_emission_sources ADD COLUMN asset_identifier_sealed jsonb;
ALTER TABLE nzi_console.job_emission_sources ADD COLUMN asset_identifier_bidx text;
ALTER TABLE nzi_console.job_scope_rows ADD COLUMN asset_identifier_bidx text;
COMMENT ON COLUMN nzi_console.job_emission_sources.asset_identifier_sealed IS
  'D4: a company vehicle''s registration, sealed under the client''s vehicle-registration key (client_data_keys). Plaintext asset_identifier is cleared for vehicles.';
COMMENT ON COLUMN nzi_console.job_emission_sources.asset_identifier_bidx IS
  'D4: a keyed digest of the normalised registration, scoped to the client — the vehicle''s year-on-year identity, never read back.';
COMMENT ON COLUMN nzi_console.job_scope_rows.asset_identifier_bidx IS
  'D4: as job_emission_sources.asset_identifier_bidx.';
CREATE INDEX job_scope_rows_vehicle_identity_idx ON nzi_console.job_scope_rows (organisation_id, asset_identifier_bidx) WHERE asset_identifier_bidx IS NOT NULL;

ALTER TABLE nzi_console.clients ADD COLUMN vehicle_registrations_opt_out boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN nzi_console.clients.vehicle_registrations_opt_out IS
  'D4 (R1): the client asked that no vehicle registration be held. Vehicles are identified by a name or fleet number instead.';

COMMIT;
