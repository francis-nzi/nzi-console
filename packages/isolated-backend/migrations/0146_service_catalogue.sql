-- 0146 The service catalogue (admin Phase E2; ruled plan `phaseE-commercial-catalogue-plan.md`, E-Q4/E-Q5/E-Q8/E-Q9):
-- `job_items`, what a quote line or a job line is chosen from.
--
-- ## What it adds
--
-- **`job_items`** (R2: typed, its own table) — per organisation:
-- - `item_code`: the identity a downstream job line is copied from, so **set once** (E-Q4): the application role may
--   insert it but holds no UPDATE on it. Unique per organisation, case-insensitively, inactive rows included.
-- - `name`, `description`, `sort_order`;
-- - `category_value_id` → the governed `job_item_categories` lookup, `unit_value_id` → `units_of_measure` (Phase A's
--   reference values; the commands check each value's category);
-- - `default_hours`, and `vat_rate_id` → E1's VAT rates;
-- - `default_cost_amount`, `default_sell_amount` — **commercially sensitive** (E-Q8): read and written only with
--   finance.manage, through a command of their own whose audit records that amounts changed, never what they are
--   (NZC-120). Null until priced.
-- - `currency_code` → E1's currencies: the organisation's selling currency the amounts are held in (E-Q9 — one currency
--   per catalogue; a multi-currency catalogue is deferred with `exchange_rate`).
-- - `active`, `version`, who-and-when, and 0132's import provenance.
--
-- E builds the catalogue only (E-Q5): `job_line_items`, the snapshot copied at job creation, is downstream; a catalogue
-- edit never reaches an existing job line. Deactivate, never delete (R3): a deactivated item leaves the picker but still
-- resolves wherever it is named. Forced row-level security and the tenant policy; no DELETE for anyone.

BEGIN;

CREATE TABLE nzi_console.job_items (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  item_id text NOT NULL,
  item_code text NOT NULL CHECK (item_code ~ '^[A-Z0-9][A-Z0-9_-]{0,29}$'),
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  description text CHECK (description IS NULL OR (btrim(description) <> '' AND length(description) <= 1000)),
  category_value_id text,
  unit_value_id text,
  default_hours numeric(8,2) CHECK (default_hours IS NULL OR (default_hours >= 0 AND default_hours <= 10000)),
  default_cost_amount numeric(12,2) CHECK (default_cost_amount IS NULL OR default_cost_amount >= 0),
  default_sell_amount numeric(12,2) CHECK (default_sell_amount IS NULL OR default_sell_amount >= 0),
  currency_code text NOT NULL,
  vat_rate_id text,
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0 AND sort_order <= 1000000),
  active boolean NOT NULL DEFAULT true,
  source_system text,
  legacy_db_id text,
  legacy_values jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),
  PRIMARY KEY (organisation_id, item_id),
  FOREIGN KEY (organisation_id, category_value_id) REFERENCES nzi_console.reference_values (organisation_id, value_id),
  FOREIGN KEY (organisation_id, unit_value_id) REFERENCES nzi_console.reference_values (organisation_id, value_id),
  FOREIGN KEY (organisation_id, currency_code) REFERENCES nzi_console.currencies (organisation_id, code),
  FOREIGN KEY (organisation_id, vat_rate_id) REFERENCES nzi_console.vat_rates (organisation_id, vat_rate_id),
  CONSTRAINT job_items_import_provenance_shape CHECK (
    (source_system IS NULL AND legacy_db_id IS NULL AND legacy_values IS NULL)
    OR (source_system IS NOT NULL AND btrim(source_system) <> '' AND legacy_db_id IS NOT NULL AND btrim(legacy_db_id) <> ''
        AND legacy_values IS NOT NULL))
);
CREATE UNIQUE INDEX job_items_code_key ON nzi_console.job_items (organisation_id, lower(item_code));
CREATE UNIQUE INDEX job_items_import_identity_key ON nzi_console.job_items (organisation_id, source_system, legacy_db_id)
  WHERE source_system IS NOT NULL;
CREATE INDEX job_items_category_idx ON nzi_console.job_items (organisation_id, category_value_id) WHERE category_value_id IS NOT NULL;
CREATE INDEX job_items_vat_rate_idx ON nzi_console.job_items (organisation_id, vat_rate_id) WHERE vat_rate_id IS NOT NULL;
COMMENT ON TABLE nzi_console.job_items IS
  'The service catalogue (admin E2): item code set once (E-Q4), cost/sell finance-gated and never in audit values (E-Q8), one selling currency (E-Q9). The source a job line is copied from at creation (E-Q5); never deleted.';
COMMENT ON COLUMN nzi_console.job_items.default_sell_amount IS
  'Commercially sensitive (E-Q8): read and written only with finance.manage (job_item.price.set); its audit says that it changed, never the amount.';

ALTER TABLE nzi_console.job_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.job_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.job_items
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
REVOKE ALL ON nzi_console.job_items FROM PUBLIC;
-- The item code is inserted once and never updated: no UPDATE on the column (E-Q4).
GRANT SELECT, INSERT ON nzi_console.job_items TO nzi_console_app;
GRANT UPDATE (name, description, category_value_id, unit_value_id, default_hours, default_cost_amount, default_sell_amount, currency_code,
  vat_rate_id, sort_order, active, source_system, legacy_db_id, legacy_values, version, updated_at, updated_by)
  ON nzi_console.job_items TO nzi_console_app;

COMMIT;
