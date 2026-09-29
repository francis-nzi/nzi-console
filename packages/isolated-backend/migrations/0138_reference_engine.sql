-- 0138 The reference-value engine (admin Phase A2; ruled plan `admin-phaseA-plan.md`, P3–P5).
--
-- ## What it adds
--
-- 1. **Ten lookup categories** (P3), all `organisation` scope, none carrying a code (P4 — v7's simple lookups have
--    none): portfolios, payment terms, positions, processes, client teams, action categories, governance subjects,
--    BD bin reasons, units of measure and job item categories. Industries and referrals already exist (0089).
--    Categories stay migration-owned: the application role keeps SELECT only on `reference_categories` (R7).
-- 2. **v7 provenance on `reference_values`**, following 0132 and 0137: `source_system`, `legacy_db_id` and
--    `legacy_values` (what the value was last loaded as — what a re-run compares, so a console edit is never mistaken
--    for a v7 change). One v7 row maps to one value, per category (v7's lookup tables each number from 1).
--    The existing `source` / `source_ref` stay: a seeded value is `source='import'` with no `source_system`.
-- 3. **`clients.portfolio_value_id`**, beside 0090's `sector_value_id` / `referral_value_id`, referencing a value the
--    same way. The `portfolio` text column stays as the record of what was imported.
-- 4. **`portfolio_owners`** (P5) — the client that owns a portfolio (v7's `portfolio_owner_client_db_id`), which until
--    now had nowhere to live. One owner per portfolio.
--
-- ## What it does not do
--
-- Load anything (that is A3, `load:v7-lookups`), or link clients (A4). No DELETE is granted anywhere (R3): a value is
-- deactivated, never removed, and still resolves on the records that use it.

BEGIN;

INSERT INTO nzi_console.reference_categories (category_key, label, scope, description, carries_code, code_label) VALUES
  ('portfolios',          'Portfolios',          'organisation', 'Owner-led client groupings.',                              false, NULL),
  ('payment_terms',       'Payment terms',       'organisation', 'Applied to quotes and invoices.',                          false, NULL),
  ('positions',           'Positions',           'organisation', 'Job titles on the team roster.',                           false, NULL),
  ('processes',           'Processes',           'organisation', 'The internal processes feedback is filed against.',        false, NULL),
  ('client_teams',        'Client teams',        'organisation', 'The client-side teams that own SRS and reduction actions.', false, NULL),
  ('action_categories',   'Action categories',   'organisation', 'Groups reduction actions in reports and the portal.',      false, NULL),
  ('governance_subjects', 'Governance subjects', 'organisation', 'The subjects governance items are recorded under.',        false, NULL),
  ('bd_bin_reasons',      'BD bin reasons',      'organisation', 'Why a business-development lead was closed.',              false, NULL),
  ('units_of_measure',    'Units of measure',    'organisation', 'Quantities on job items and supplier rates.',              false, NULL),
  ('job_item_categories', 'Job item categories', 'organisation', 'Groups the service catalogue.',                            false, NULL);

ALTER TABLE nzi_console.reference_values
  ADD COLUMN source_system text,
  ADD COLUMN legacy_db_id text,
  ADD COLUMN legacy_values jsonb,
  -- The import-provenance shape of 0132: an imported value names its v7 id and what it was loaded as; a value seeded
  -- or made here names none of them.
  ADD CONSTRAINT reference_values_import_provenance_shape CHECK (
    (source_system IS NULL AND legacy_db_id IS NULL AND legacy_values IS NULL)
    OR (source_system IS NOT NULL AND btrim(source_system) <> '' AND legacy_db_id IS NOT NULL AND btrim(legacy_db_id) <> ''
        AND legacy_values IS NOT NULL));

CREATE UNIQUE INDEX reference_values_import_identity_key
  ON nzi_console.reference_values (organisation_id, category_key, source_system, legacy_db_id)
  WHERE source_system IS NOT NULL;

COMMENT ON COLUMN nzi_console.reference_values.legacy_values IS
  'The v7 values this value was last loaded with. A re-run compares v7 against these, not against the row, so a console edit is never mistaken for a v7 change (ruled R4).';

ALTER TABLE nzi_console.clients
  ADD COLUMN portfolio_value_id text,
  ADD CONSTRAINT clients_portfolio_reference_fk
    FOREIGN KEY (organisation_id, portfolio_value_id)
    REFERENCES nzi_console.reference_values (organisation_id, value_id);

CREATE INDEX clients_portfolio_value_idx ON nzi_console.clients (organisation_id, portfolio_value_id)
  WHERE portfolio_value_id IS NOT NULL;

CREATE TABLE nzi_console.portfolio_owners (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  portfolio_value_id text NOT NULL,
  owner_client_id text NOT NULL,
  source_system text,
  legacy_db_id text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),
  PRIMARY KEY (organisation_id, portfolio_value_id),
  FOREIGN KEY (organisation_id, portfolio_value_id) REFERENCES nzi_console.reference_values (organisation_id, value_id),
  FOREIGN KEY (organisation_id, owner_client_id) REFERENCES nzi_console.clients (organisation_id, client_id),
  CONSTRAINT portfolio_owners_import_provenance_shape CHECK (
    (source_system IS NULL AND legacy_db_id IS NULL)
    OR (source_system IS NOT NULL AND btrim(source_system) <> '' AND legacy_db_id IS NOT NULL AND btrim(legacy_db_id) <> ''))
);

COMMENT ON TABLE nzi_console.portfolio_owners IS
  'The client that owns a portfolio (v7 portfolios_lookup.portfolio_owner_client_db_id) — one owner per portfolio value. Filled by load:v7-lookups (admin A3).';

ALTER TABLE nzi_console.portfolio_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.portfolio_owners FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.portfolio_owners
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
REVOKE ALL ON nzi_console.portfolio_owners FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON nzi_console.portfolio_owners TO nzi_console_app;

COMMIT;
