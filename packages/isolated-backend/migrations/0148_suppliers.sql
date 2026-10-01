-- 0148 Suppliers and their rate card (admin Phase E4; ruled plan `phaseE-commercial-catalogue-plan.md`, E-Q6/E-Q7/E-Q8/
-- E-Q9): the subcontractors a job's other costs will be bought from, the people at them, and what they charge.
--
-- ## What it adds
--
-- 1. **`suppliers`** — the company: a name (unique per organisation, case-insensitively, inactive included) and a
--    website. No personal data: the people are the next table, and v7's free-text `address` and `notes` are not
--    carried (a sole trader's address is personal, and notes are unknown text — admin E4, for ruling).
-- 2. **`supplier_contacts`** — the people at a supplier, **third-party personal data (R8, E-Q6), sealed per person**
--    exactly as client contacts are (NZC-119): name, email and phone are written in plaintext *and* sealed under the
--    contact's own subject key in the same transaction, the email blind-indexed; erasure shreds the key and nulls the
--    plaintext (so the plaintext columns are nullable). Each contact is its own data subject — a person can be erased
--    without touching the company — so `supplier_contacts` joins the subject registry's person-tables below.
-- 3. **`supplier_service_items`** — the rate card: a supplier's priced services — a cost type, a name and
--    description, a unit (→ `units_of_measure`), VAT (→ E1's rates), and the **agreed rate**, commercially sensitive
--    (E-Q8): read and written only with finance.manage, its audit saying that it changed, never what it is (NZC-120).
--    Held in the organisation's selling currency (E-Q9).
-- 4. **The subject registry admits `supplier_contacts`**: the three `source_table` CHECKs (0098, 0101) and
--    `record_subject_linkage`'s per-table existence check (0103, replaced here with one more branch; the rest
--    verbatim).
--
-- ## Throughout
--
-- Forced row-level security and the tenant policy; no DELETE for anyone (R3 — deactivate, never delete; a contact is
-- removed only by erasure, which nulls and shreds rather than deletes); 0132's import provenance. No table or column
-- name here carries a retention carve-out's vocabulary.

BEGIN;

-- ── 1. Suppliers ──────────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE nzi_console.suppliers (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  supplier_id text NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 160),
  website text CHECK (website IS NULL OR (btrim(website) <> '' AND length(website) <= 200)),
  active boolean NOT NULL DEFAULT true,
  source_system text,
  legacy_db_id text,
  legacy_values jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),
  PRIMARY KEY (organisation_id, supplier_id),
  CONSTRAINT suppliers_import_provenance_shape CHECK (
    (source_system IS NULL AND legacy_db_id IS NULL AND legacy_values IS NULL)
    OR (source_system IS NOT NULL AND btrim(source_system) <> '' AND legacy_db_id IS NOT NULL AND btrim(legacy_db_id) <> ''
        AND legacy_values IS NOT NULL))
);
CREATE UNIQUE INDEX suppliers_name_key ON nzi_console.suppliers (organisation_id, lower(name));
CREATE UNIQUE INDEX suppliers_import_identity_key ON nzi_console.suppliers (organisation_id, source_system, legacy_db_id) WHERE source_system IS NOT NULL;
COMMENT ON TABLE nzi_console.suppliers IS
  'Suppliers (admin E4): the company only — its people are supplier_contacts (sealed), its prices supplier_service_items (finance-gated). Never deleted.';

-- ── 2. Supplier contacts (sealed per person) ─────────────────────────────────────────────────────────────────────

CREATE TABLE nzi_console.supplier_contacts (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  contact_id text NOT NULL,
  supplier_id text NOT NULL,
  -- Plaintext beside its ciphertext (NZC-119's dual write); nullable, because erasure nulls it.
  full_name text CHECK (full_name IS NULL OR (btrim(full_name) <> '' AND length(full_name) <= 120)),
  email text CHECK (email IS NULL OR (btrim(email) <> '' AND length(email) <= 254)),
  phone text CHECK (phone IS NULL OR (btrim(phone) <> '' AND length(phone) <= 40)),
  full_name_sealed jsonb,
  email_sealed jsonb,
  email_bidx text,
  phone_sealed jsonb,
  active boolean NOT NULL DEFAULT true,
  source_system text,
  legacy_db_id text,
  -- Never a name, an address or a number: what v7 held is recorded as a keyed digest (as memberships record theirs).
  legacy_values jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),
  PRIMARY KEY (organisation_id, contact_id),
  FOREIGN KEY (organisation_id, supplier_id) REFERENCES nzi_console.suppliers (organisation_id, supplier_id),
  CONSTRAINT supplier_contacts_import_provenance_shape CHECK (
    (source_system IS NULL AND legacy_db_id IS NULL AND legacy_values IS NULL)
    OR (source_system IS NOT NULL AND btrim(source_system) <> '' AND legacy_db_id IS NOT NULL AND btrim(legacy_db_id) <> ''
        AND legacy_values IS NOT NULL))
);
CREATE INDEX supplier_contacts_supplier_idx ON nzi_console.supplier_contacts (organisation_id, supplier_id);
CREATE INDEX supplier_contacts_email_bidx_idx ON nzi_console.supplier_contacts (organisation_id, email_bidx);
CREATE UNIQUE INDEX supplier_contacts_import_identity_key ON nzi_console.supplier_contacts (organisation_id, source_system, legacy_db_id) WHERE source_system IS NOT NULL;
COMMENT ON TABLE nzi_console.supplier_contacts IS
  'The people at a supplier (admin E4) — third-party personal data, sealed per person (NZC-119, E-Q6): each contact its own data subject, erased by shredding its key. Never deleted.';
COMMENT ON COLUMN nzi_console.supplier_contacts.legacy_values IS
  'What v7 held for this contact when last imported — as a keyed digest and the fields present, never a name, address or number.';

-- ── 3. The rate card ─────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE nzi_console.supplier_service_items (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  service_item_id text NOT NULL,
  supplier_id text NOT NULL,
  cost_type text CHECK (cost_type IS NULL OR (btrim(cost_type) <> '' AND length(cost_type) <= 60)),
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 160),
  description text CHECK (description IS NULL OR (btrim(description) <> '' AND length(description) <= 1000)),
  unit_value_id text,
  vat_rate_id text,
  agreed_rate numeric(12,2) CHECK (agreed_rate IS NULL OR agreed_rate >= 0),
  currency_code text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  source_system text,
  legacy_db_id text,
  legacy_values jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),
  PRIMARY KEY (organisation_id, service_item_id),
  FOREIGN KEY (organisation_id, supplier_id) REFERENCES nzi_console.suppliers (organisation_id, supplier_id),
  FOREIGN KEY (organisation_id, unit_value_id) REFERENCES nzi_console.reference_values (organisation_id, value_id),
  FOREIGN KEY (organisation_id, vat_rate_id) REFERENCES nzi_console.vat_rates (organisation_id, vat_rate_id),
  FOREIGN KEY (organisation_id, currency_code) REFERENCES nzi_console.currencies (organisation_id, code),
  CONSTRAINT supplier_service_items_import_provenance_shape CHECK (
    (source_system IS NULL AND legacy_db_id IS NULL AND legacy_values IS NULL)
    OR (source_system IS NOT NULL AND btrim(source_system) <> '' AND legacy_db_id IS NOT NULL AND btrim(legacy_db_id) <> ''
        AND legacy_values IS NOT NULL))
);
CREATE INDEX supplier_service_items_supplier_idx ON nzi_console.supplier_service_items (organisation_id, supplier_id);
CREATE UNIQUE INDEX supplier_service_items_name_key ON nzi_console.supplier_service_items (organisation_id, supplier_id, lower(name));
CREATE UNIQUE INDEX supplier_service_items_import_identity_key ON nzi_console.supplier_service_items (organisation_id, source_system, legacy_db_id) WHERE source_system IS NOT NULL;
COMMENT ON TABLE nzi_console.supplier_service_items IS
  'A supplier''s rate card (admin E4): the agreed rate is finance-gated and never in audit values (E-Q8); one currency (E-Q9). Never deleted.';

-- ── Tenancy and grants: forced RLS everywhere; no DELETE for anyone ──────────────────────────────────────────────

ALTER TABLE nzi_console.suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.suppliers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.suppliers
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
ALTER TABLE nzi_console.supplier_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.supplier_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.supplier_contacts
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
ALTER TABLE nzi_console.supplier_service_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.supplier_service_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.supplier_service_items
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

REVOKE ALL ON nzi_console.suppliers, nzi_console.supplier_contacts, nzi_console.supplier_service_items FROM PUBLIC;
GRANT SELECT, INSERT ON nzi_console.suppliers, nzi_console.supplier_contacts, nzi_console.supplier_service_items TO nzi_console_app;
GRANT UPDATE (name, website, active, source_system, legacy_db_id, legacy_values, version, updated_at, updated_by)
  ON nzi_console.suppliers TO nzi_console_app;
-- A rate-card line's supplier, and a contact's, is fixed once made: no UPDATE on `supplier_id`.
GRANT UPDATE (cost_type, name, description, unit_value_id, vat_rate_id, agreed_rate, currency_code, active, source_system, legacy_db_id,
  legacy_values, version, updated_at, updated_by) ON nzi_console.supplier_service_items TO nzi_console_app;
GRANT UPDATE (full_name, email, phone, full_name_sealed, email_sealed, email_bidx, phone_sealed, active, source_system, legacy_db_id, legacy_values,
  version, updated_at, updated_by) ON nzi_console.supplier_contacts TO nzi_console_app;

-- ── 4. The subject registry admits supplier contacts ─────────────────────────────────────────────────────────────

ALTER TABLE nzi_console.data_subject_links DROP CONSTRAINT data_subject_links_source_table_check;
ALTER TABLE nzi_console.data_subject_links ADD CONSTRAINT data_subject_links_source_table_check
  CHECK (source_table IN ('trainees', 'client_contacts', 'portal_users', 'memberships', 'supplier_contacts'));
ALTER TABLE nzi_console.data_subject_review_members DROP CONSTRAINT data_subject_review_members_source_table_check;
ALTER TABLE nzi_console.data_subject_review_members ADD CONSTRAINT data_subject_review_members_source_table_check
  CHECK (source_table IN ('trainees', 'client_contacts', 'portal_users', 'memberships', 'supplier_contacts'));
ALTER TABLE nzi_console.data_subject_linkage DROP CONSTRAINT data_subject_linkage_source_table_check;
ALTER TABLE nzi_console.data_subject_linkage ADD CONSTRAINT data_subject_linkage_source_table_check
  CHECK (source_table IN ('trainees', 'client_contacts', 'portal_users', 'memberships', 'trainee_email_changes', 'supplier_contacts'));

-- 0103's function, verbatim, with one more table in its existence check.
CREATE OR REPLACE FUNCTION nzi_console.record_subject_linkage(
  p_organisation_id text,
  p_source_table text,
  p_source_id text,
  p_field text,
  p_linkage_bidx text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = nzi_console, pg_temp AS $$
BEGIN
  -- The caller may only write inside its own tenant context. Same shape as
  -- `revoke_trainee_sessions`: a definer function's first job is to refuse the thing its privilege
  -- would otherwise allow.
  IF p_organisation_id IS DISTINCT FROM current_setting('app.organisation_id', true) THEN
    RAISE EXCEPTION 'Cannot record linkage outside the current organisation' USING ERRCODE = '42501';
  END IF;

  -- The person has to exist. There are no foreign keys here to say so, and a linkage row for nobody is
  -- a row the linker would try to reconcile for ever. Written out per table rather than as dynamic SQL,
  -- because dynamic SQL inside a definer function is where injection lives.
  IF NOT (
    (p_source_table = 'trainees' AND EXISTS (
      SELECT 1 FROM nzi_console.trainees WHERE organisation_id = p_organisation_id AND trainee_id = p_source_id))
    OR (p_source_table = 'client_contacts' AND EXISTS (
      SELECT 1 FROM nzi_console.client_contacts WHERE organisation_id = p_organisation_id AND contact_id = p_source_id))
    OR (p_source_table = 'portal_users' AND EXISTS (
      SELECT 1 FROM nzi_console.portal_users WHERE organisation_id = p_organisation_id AND portal_user_id = p_source_id))
    OR (p_source_table = 'memberships' AND EXISTS (
      SELECT 1 FROM nzi_console.memberships WHERE organisation_id = p_organisation_id AND user_id = p_source_id))
    OR (p_source_table = 'trainee_email_changes' AND EXISTS (
      SELECT 1 FROM nzi_console.trainee_email_changes WHERE organisation_id = p_organisation_id AND change_id = p_source_id))
    OR (p_source_table = 'supplier_contacts' AND EXISTS (
      SELECT 1 FROM nzi_console.supplier_contacts WHERE organisation_id = p_organisation_id AND contact_id = p_source_id))
  ) THEN
    RAISE EXCEPTION 'No % row to record linkage for', p_source_table USING ERRCODE = '23503';
  END IF;

  INSERT INTO nzi_console.data_subject_linkage (organisation_id, source_table, source_id, field, linkage_bidx)
  VALUES (p_organisation_id, p_source_table, p_source_id, p_field, p_linkage_bidx)
  ON CONFLICT (organisation_id, source_table, source_id, field)
  DO UPDATE SET linkage_bidx = EXCLUDED.linkage_bidx, computed_at = now();
END $$;

COMMIT;
