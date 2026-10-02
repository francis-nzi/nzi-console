-- 0151 Custom field definitions (admin Phase F3; ruled plan `phaseF-comms-crm-plan.md`, F-Q5): the extra fields an
-- organisation adds to its clients, jobs, contacts, quotes and suppliers.
--
-- ## What it adds
--
-- **`custom_field_definitions`** — per organisation (v7's were global), typed (R2), so its own table:
--
-- - **Set once** (no UPDATE granted): `entity_type`, `field_key` — the identity a value is stored against, unique per
--   entity — and `field_type`. v7 let all three change in place, which left the values already stored orphaned or
--   mistyped; here a field that needs a different type is a new field.
-- - `options` (a select's, as `[{value, label, active}]`): an option's value is never removed — options are added,
--   relabelled and deactivated — so every value already held still resolves. The command enforces it; the CHECK here
--   holds only the shape.
-- - `required`, `sort_order`, `default_value` (valid for the type, checked by the command), `active`, version, 0132
--   provenance.
--
-- **Definitions only (F-Q5).** The values are each entity's own workstream's, under
-- `docs/CUSTOM_FIELD_VALUES_CONTRACT.md`; no values table is made here. Forced row-level security and the tenant policy;
-- no DELETE for anyone (R3).

BEGIN;

CREATE TABLE nzi_console.custom_field_definitions (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  definition_id text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('client', 'job', 'contact', 'quote', 'supplier')),
  field_key text NOT NULL CHECK (field_key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  field_type text NOT NULL CHECK (field_type IN ('text', 'long_text', 'number', 'decimal', 'date', 'checkbox', 'select')),
  label text NOT NULL CHECK (btrim(label) <> '' AND length(label) <= 120),
  required boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  options jsonb CHECK (options IS NULL OR jsonb_typeof(options) = 'array'),
  default_value text CHECK (default_value IS NULL OR length(default_value) <= 500),
  active boolean NOT NULL DEFAULT true,
  source_system text,
  legacy_db_id text,
  legacy_values jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),
  PRIMARY KEY (organisation_id, definition_id),
  -- Options belong to a select alone.
  CONSTRAINT custom_field_definitions_options_for_select CHECK ((field_type = 'select') = (options IS NOT NULL)),
  CONSTRAINT custom_field_definitions_import_provenance_shape CHECK (
    (source_system IS NULL AND legacy_db_id IS NULL AND legacy_values IS NULL)
    OR (source_system IS NOT NULL AND btrim(source_system) <> '' AND legacy_db_id IS NOT NULL AND btrim(legacy_db_id) <> ''
        AND legacy_values IS NOT NULL))
);
CREATE UNIQUE INDEX custom_field_definitions_key ON nzi_console.custom_field_definitions (organisation_id, entity_type, field_key);
CREATE UNIQUE INDEX custom_field_definitions_import_identity_key ON nzi_console.custom_field_definitions (organisation_id, source_system, legacy_db_id)
  WHERE source_system IS NOT NULL;
COMMENT ON TABLE nzi_console.custom_field_definitions IS
  'Custom field definitions (admin F3): entity, key and type set once; options never removed; definitions only — the values are each entity workstream''s (docs/CUSTOM_FIELD_VALUES_CONTRACT.md). Never deleted.';

ALTER TABLE nzi_console.custom_field_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.custom_field_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.custom_field_definitions
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
REVOKE ALL ON nzi_console.custom_field_definitions FROM PUBLIC;
-- Entity, key and type are inserted once and never updated.
GRANT SELECT, INSERT ON nzi_console.custom_field_definitions TO nzi_console_app;
GRANT UPDATE (label, required, sort_order, options, default_value, active, source_system, legacy_db_id, legacy_values, version, updated_at, updated_by)
  ON nzi_console.custom_field_definitions TO nzi_console_app;

COMMIT;
