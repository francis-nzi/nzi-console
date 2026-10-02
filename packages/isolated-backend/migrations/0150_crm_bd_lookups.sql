-- 0150 CRM and business-development lookups (admin Phase F2; ruled plan `phaseF-comms-crm-plan.md`, F-Q4).
--
-- ## What it adds
--
-- 1. **Two lookup categories** on the reference-value engine (F-Q4), migration-owned as every category is (the
--    application role keeps SELECT only on `reference_categories`, R2/R7):
--    - `crm_tags` — the tags a CRM timeline event is filed under. A label only: v7's tags carry an optional colour that
--      v7's own screens never show, so the colour is kept in the import's record of what v7 held, not modelled (F-Q4:
--      a tag gets its own table only if it must carry a colour).
--    - `bd_service_lines` — the service lines business development targets. **Carries a code**: v7 identifies a service
--      line by its key (`carbon-reduction-plan`), and its leads name one by that key, so the key travels as the code.
-- 2. **`bd_funnel_stages`** — typed (R2), so its own table: the stages an opportunity moves through, each with a **key
--    set once** (the identity an opportunity will name), a name, its **order**, and a **probability** (0–100%, to two
--    places). Ordered, not defaulted: the entry stage is the first active one by order, as v7 takes it — so there is no
--    default flag to drift, and deactivating the last active stage is refused by the command.
--
-- Forced row-level security and the tenant policy; no DELETE for anyone (R3); 0132's import provenance. The
-- opportunities that will name a stage are the downstream BD workstream's (admin-plan §3), not F's.

BEGIN;

INSERT INTO nzi_console.reference_categories (category_key, label, scope, description, carries_code, code_label) VALUES
  ('crm_tags',         'CRM tags',          'organisation', 'The tags CRM timeline events are filed under.',              false, NULL),
  ('bd_service_lines', 'BD service lines',  'organisation', 'The service lines business development targets leads at.', true,  'Key');

CREATE TABLE nzi_console.bd_funnel_stages (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  stage_id text NOT NULL,
  stage_key text NOT NULL CHECK (stage_key ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 80),
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  probability_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (probability_pct >= 0 AND probability_pct <= 100),
  active boolean NOT NULL DEFAULT true,
  source_system text,
  legacy_db_id text,
  legacy_values jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),
  PRIMARY KEY (organisation_id, stage_id),
  CONSTRAINT bd_funnel_stages_import_provenance_shape CHECK (
    (source_system IS NULL AND legacy_db_id IS NULL AND legacy_values IS NULL)
    OR (source_system IS NOT NULL AND btrim(source_system) <> '' AND legacy_db_id IS NOT NULL AND btrim(legacy_db_id) <> ''
        AND legacy_values IS NOT NULL))
);
CREATE UNIQUE INDEX bd_funnel_stages_key ON nzi_console.bd_funnel_stages (organisation_id, stage_key);
CREATE UNIQUE INDEX bd_funnel_stages_name_key ON nzi_console.bd_funnel_stages (organisation_id, lower(name));
CREATE UNIQUE INDEX bd_funnel_stages_import_identity_key ON nzi_console.bd_funnel_stages (organisation_id, source_system, legacy_db_id)
  WHERE source_system IS NOT NULL;
COMMENT ON TABLE nzi_console.bd_funnel_stages IS
  'The business-development funnel (admin F2): ordered stages, each with a key set once and a probability. The entry stage is the first active by order. Never deleted.';

ALTER TABLE nzi_console.bd_funnel_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.bd_funnel_stages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.bd_funnel_stages
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
REVOKE ALL ON nzi_console.bd_funnel_stages FROM PUBLIC;
-- The key is inserted once and never updated.
GRANT SELECT, INSERT ON nzi_console.bd_funnel_stages TO nzi_console_app;
GRANT UPDATE (name, sort_order, probability_pct, active, source_system, legacy_db_id, legacy_values, version, updated_at, updated_by)
  ON nzi_console.bd_funnel_stages TO nzi_console_app;

COMMIT;
