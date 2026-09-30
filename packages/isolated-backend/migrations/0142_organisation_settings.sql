-- 0142 Organisation settings (admin Phase D, D1; ruled plan `phaseD-org-settings-plan.md`, Q1–Q11).
--
-- ## What it adds
--
-- 1. **`organisation_profiles`** (Q1) — the company profile as typed columns, one row per organisation, never a
--    key-value store: legal and display name, registration and VAT number, registered address, contact, the logo
--    pointer, an optional footer override (Q11: the footer is otherwise *derived* from the profile, by one function,
--    so a changed VAT number cannot leave a stale footer behind), and the certificate signatory — a membership and a
--    title (Q6), the name read from the sealed membership, never copied here as text. The row is **provisioned**, so
--    every command is an update under `expectedVersion`: the application holds SELECT and UPDATE only.
-- 2. **`organisation_bank_details`** (Q2, Q3) — apart from the profile, so no profile read can ever carry them: account
--    name, sort code, account number. Not sealed — company financial data with no data subject, and sealing is for
--    erasure — but read by one capability-checked function, never on a public route, never in a command payload, a
--    change always says why. IBAN and BIC are Phase E (Q9). Provisioned; SELECT and UPDATE only.
-- 3. **`organisation_logo_assets`** — 0068's client-logo pattern, reused: PNG or SVG, at most 256 KB, sha256,
--    append-only. The profile points at the current one; removing the logo clears the pointer and keeps the asset.
-- 4. **`organisation_intensity_metric_defaults`** (§4) — the intensity metrics a new client starts with, in
--    `client_intensity_metrics`' own shape, versioned and append-only. Seeded with 0071's standard pair.
--    `client.create` applies them; the 433 existing clients with none get them only by an explicit, audited apply
--    (Q5) — **this migration writes no client data**.
-- 5. **Provisioning** — a profile row, a bank row and the standard defaults for every organisation now, and for every
--    organisation inserted from now on, by their own trigger. `provision_organisation()` (generated, and guarded by
--    a drift test) is left untouched.
--
-- Every table is per organisation under forced row-level security with the tenant policy, and nobody holds DELETE.
-- `admin.settings` (Admin) governs every write; it is already in matrix v8 (0131), so there is no matrix bump.

BEGIN;

-- ── Logo assets (0068's pattern) ────────────────────────────────────────────────────────────────────────────────

CREATE TABLE nzi_console.organisation_logo_assets (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  asset_id text NOT NULL,
  file_name text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/png','image/svg+xml')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 262144),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea NOT NULL,
  uploaded_by text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, asset_id)
);

-- ── The profile ─────────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE nzi_console.organisation_profiles (
  organisation_id text PRIMARY KEY REFERENCES nzi_console.organisations(organisation_id),
  legal_name text CHECK (legal_name IS NULL OR (legal_name = btrim(legal_name) AND legal_name <> '' AND length(legal_name) <= 200)),
  display_name text CHECK (display_name IS NULL OR (display_name = btrim(display_name) AND display_name <> '' AND length(display_name) <= 120)),
  registration_number text CHECK (registration_number IS NULL OR registration_number ~ '^[A-Z0-9]{1,20}$'),
  vat_number text CHECK (vat_number IS NULL OR vat_number ~ '^[A-Z]{0,2}[0-9A-Z]{2,15}$'),
  address_line_1 text CHECK (address_line_1 IS NULL OR (address_line_1 = btrim(address_line_1) AND address_line_1 <> '' AND length(address_line_1) <= 200)),
  address_line_2 text CHECK (address_line_2 IS NULL OR (address_line_2 = btrim(address_line_2) AND address_line_2 <> '' AND length(address_line_2) <= 200)),
  address_city text CHECK (address_city IS NULL OR (address_city = btrim(address_city) AND address_city <> '' AND length(address_city) <= 100)),
  address_region text CHECK (address_region IS NULL OR (address_region = btrim(address_region) AND address_region <> '' AND length(address_region) <= 100)),
  address_postcode text CHECK (address_postcode IS NULL OR (address_postcode = btrim(address_postcode) AND address_postcode <> '' AND length(address_postcode) <= 20)),
  -- Free text, as v7 holds it (Q8); an ISO code can come later.
  address_country text CHECK (address_country IS NULL OR (address_country = btrim(address_country) AND address_country <> '' AND length(address_country) <= 100)),
  contact_email text CHECK (contact_email IS NULL OR (length(contact_email) <= 254 AND contact_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')),
  contact_phone text CHECK (contact_phone IS NULL OR (contact_phone = btrim(contact_phone) AND contact_phone ~ '^[0-9+() .-]{5,30}$')),
  website_url text CHECK (website_url IS NULL OR (length(website_url) <= 300 AND website_url ~ '^https?://[^[:space:]]+$')),
  logo_asset_id text,
  -- Q11: the footer is derived from the profile; this, when set, replaces it.
  footer_override text CHECK (footer_override IS NULL OR (footer_override = btrim(footer_override) AND footer_override <> '' AND length(footer_override) <= 500)),
  -- Q6: a member of staff, named from their sealed membership, and the title they sign under.
  signatory_user_id text,
  signatory_title text CHECK (signatory_title IS NULL OR (signatory_title = btrim(signatory_title) AND signatory_title <> '' AND length(signatory_title) <= 120)),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),
  source_system text,
  -- Per imported field, a sha256 of what was imported — never the value (the D2 import's R4 comparison).
  legacy_values jsonb,
  FOREIGN KEY (organisation_id, logo_asset_id) REFERENCES nzi_console.organisation_logo_assets (organisation_id, asset_id),
  FOREIGN KEY (organisation_id, signatory_user_id) REFERENCES nzi_console.memberships (organisation_id, user_id),
  CONSTRAINT organisation_profiles_signatory_shape CHECK (signatory_title IS NULL OR signatory_user_id IS NOT NULL),
  CONSTRAINT organisation_profiles_import_provenance_shape CHECK (
    (source_system IS NULL AND legacy_values IS NULL)
    OR (source_system = 'nzi-pro-v7' AND legacy_values IS NOT NULL AND jsonb_typeof(legacy_values) = 'object'))
);

-- ── Bank details, apart (Q2) ────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE nzi_console.organisation_bank_details (
  organisation_id text PRIMARY KEY REFERENCES nzi_console.organisations(organisation_id),
  account_name text CHECK (account_name IS NULL OR (account_name = btrim(account_name) AND account_name <> '' AND length(account_name) <= 140)),
  sort_code text CHECK (sort_code IS NULL OR sort_code ~ '^[0-9]{6}$'),
  account_number text CHECK (account_number IS NULL OR account_number ~ '^[0-9]{8}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),
  -- All three or none: a half-entered account is never payable.
  CONSTRAINT organisation_bank_details_whole CHECK (
    (account_name IS NULL AND sort_code IS NULL AND account_number IS NULL)
    OR (account_name IS NOT NULL AND sort_code IS NOT NULL AND account_number IS NOT NULL))
);

COMMENT ON TABLE nzi_console.organisation_bank_details IS
  'The company''s own bank account, for invoices (Phase E). Kept apart from the profile so no profile read carries it; read only behind admin.settings; never on a public route and never in a command payload; a change always has a reason. Company financial data, not personal data — so capability-gated, not sealed.';

-- ── Intensity-metric defaults (§4) ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE nzi_console.organisation_intensity_metric_defaults (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  metric_key text NOT NULL CHECK (metric_key = lower(metric_key) AND metric_key ~ '^[a-z0-9][a-z0-9_-]*$'),
  version integer NOT NULL CHECK (version > 0),
  label text NOT NULL CHECK (label = trim(label) AND label <> ''),
  unit_wording text NOT NULL CHECK (unit_wording = trim(unit_wording) AND unit_wording <> ''),
  divider integer NOT NULL DEFAULT 1 CHECK (divider IN (1, 10, 100, 1000, 10000, 100000, 1000000)),
  icon_key text NOT NULL DEFAULT 'metric' CHECK (icon_key = lower(icon_key) AND icon_key ~ '^[a-z][a-z0-9-]*$'),
  is_standard boolean NOT NULL DEFAULT false,
  value_source text NOT NULL DEFAULT 'entered' CHECK (value_source IN ('entered', 'site-floor-area')),
  active boolean NOT NULL DEFAULT true,
  ordering integer NOT NULL DEFAULT 0,
  set_by text NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text NOT NULL,
  PRIMARY KEY (organisation_id, metric_key, version)
);
CREATE INDEX organisation_intensity_metric_defaults_current_idx
  ON nzi_console.organisation_intensity_metric_defaults (organisation_id, metric_key, version DESC);

-- ── Provisioning: now, and for every organisation inserted from now on ────────────────────────────────────────

CREATE FUNCTION nzi_console.provision_organisation_settings(p_organisation_id text) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, nzi_console AS $$
BEGIN
  INSERT INTO nzi_console.organisation_profiles (organisation_id, display_name, updated_by)
  SELECT o.organisation_id, nullif(btrim(left(o.name, 120)), ''), 'migration:0142' FROM nzi_console.organisations o WHERE o.organisation_id = p_organisation_id
  ON CONFLICT (organisation_id) DO NOTHING;
  INSERT INTO nzi_console.organisation_bank_details (organisation_id, updated_by) VALUES (p_organisation_id, 'migration:0142')
  ON CONFLICT (organisation_id) DO NOTHING;
  -- 0071's standard pair, verbatim: Employees per head; Turnover per £m.
  INSERT INTO nzi_console.organisation_intensity_metric_defaults
    (organisation_id, metric_key, version, label, unit_wording, divider, icon_key, is_standard, value_source, ordering, set_by, correlation_id)
  SELECT p_organisation_id, v.metric_key, 1, v.label, v.unit_wording, v.divider, v.icon_key, true, 'entered', v.ordering, 'migration:0142', 'migration:0142'
  FROM (VALUES ('employees', 'Employees', 'employee', 1, 'people', 1), ('turnover', 'Turnover', '£m', 1000000, 'currency', 2))
    AS v(metric_key, label, unit_wording, divider, icon_key, ordering)
  WHERE NOT EXISTS (SELECT 1 FROM nzi_console.organisation_intensity_metric_defaults d WHERE d.organisation_id = p_organisation_id);
END;
$$;

CREATE FUNCTION nzi_console.provision_new_organisation_settings() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM nzi_console.provision_organisation_settings(NEW.organisation_id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER provision_settings_on_insert AFTER INSERT ON nzi_console.organisations
  FOR EACH ROW EXECUTE FUNCTION nzi_console.provision_new_organisation_settings();

SELECT nzi_console.provision_organisation_settings(organisation_id) FROM nzi_console.organisations;

-- ── Tenancy and grants: forced RLS everywhere; no DELETE for anyone ────────────────────────────────────────────

ALTER TABLE nzi_console.organisation_logo_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.organisation_logo_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.organisation_logo_assets
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
REVOKE ALL ON nzi_console.organisation_logo_assets FROM PUBLIC;
GRANT SELECT, INSERT ON nzi_console.organisation_logo_assets TO nzi_console_app;

ALTER TABLE nzi_console.organisation_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.organisation_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.organisation_profiles
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
REVOKE ALL ON nzi_console.organisation_profiles FROM PUBLIC;
-- Provisioned, never inserted by the application: every write is an update under the version.
GRANT SELECT, UPDATE ON nzi_console.organisation_profiles TO nzi_console_app;

ALTER TABLE nzi_console.organisation_bank_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.organisation_bank_details FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.organisation_bank_details
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
REVOKE ALL ON nzi_console.organisation_bank_details FROM PUBLIC;
GRANT SELECT, UPDATE ON nzi_console.organisation_bank_details TO nzi_console_app;

ALTER TABLE nzi_console.organisation_intensity_metric_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.organisation_intensity_metric_defaults FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.organisation_intensity_metric_defaults
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
REVOKE ALL ON nzi_console.organisation_intensity_metric_defaults FROM PUBLIC;
-- Versioned and append-only: a change writes the next version.
GRANT SELECT, INSERT ON nzi_console.organisation_intensity_metric_defaults TO nzi_console_app;

COMMIT;
