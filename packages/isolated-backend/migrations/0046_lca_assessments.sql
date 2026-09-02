BEGIN;

-- Job-family model batch, Phase 0 — LCA/PCF assessments, flat inventory and
-- multi-leg transport (NZC-054/055; MODEL_FIDELITY_JOB_FAMILIES.md §2). Additive,
-- inert until the LCA module reads it.
--
--  * lca_assessments — several per job (the "Model Register", e.g. a 6L vs 9L
--    variant). Versioned with optimistic concurrency; review_status is bound to
--    a reviewed version (NZC-055), not a free enum. PCF = a preset on this table.
--  * lca_line_items — FLAT, one row per EN 15804 module (NZC-054, no BOM tree).
--    Factor mapping uses the SHARED emission_factors / client_factors (NZC-056),
--    never a parallel lookup.
--  * lca_transport_legs — an ordered, geocoded leg sequence on a transport-module
--    line item; the line caches the leg sum so read-time aggregation never joins.

CREATE TABLE nzi_console.lca_assessments (
  organisation_id text NOT NULL,
  assessment_id text NOT NULL,
  job_id text NOT NULL,
  client_id text,
  assessment_type text NOT NULL DEFAULT 'product' CHECK (assessment_type IN ('product','service')),
  name text NOT NULL CHECK (nullif(trim(name), '') IS NOT NULL),
  sku text,
  description text NOT NULL DEFAULT '',
  functional_unit_value double precision NOT NULL DEFAULT 1 CHECK (functional_unit_value > 0),
  functional_unit_unit text NOT NULL DEFAULT 'unit',
  confirmed_quantity double precision CHECK (confirmed_quantity IS NULL OR confirmed_quantity >= 0),
  confirmed_quantity_unit text NOT NULL DEFAULT 'kg',
  lifecycle_boundary text NOT NULL DEFAULT 'cradle_to_gate' CHECK (lifecycle_boundary IN ('cradle_to_gate','cradle_to_grave','custom')),
  included_modules jsonb NOT NULL DEFAULT '["A1","A2","A3"]'::jsonb CHECK (jsonb_typeof(included_modules) = 'array'),
  standard text NOT NULL DEFAULT 'ISO 14067',
  reference_year integer,
  geography text,
  assumptions text NOT NULL DEFAULT '',
  data_sources_note text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved','rejected')),
  reviewed_version integer,
  reviewed_by text,
  reviewed_at timestamptz,
  reviewer_note text,
  total_tco2e double precision NOT NULL DEFAULT 0,
  last_calculated_at timestamptz,
  provenance_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provenance_json) = 'object'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz,
  PRIMARY KEY (organisation_id, assessment_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id) ON DELETE CASCADE,
  CONSTRAINT lca_assessment_reviewed_shape CHECK ((review_status = 'pending') = (reviewed_version IS NULL))
);
CREATE INDEX lca_assessments_job_idx ON nzi_console.lca_assessments(organisation_id, job_id, assessment_id);
ALTER TABLE nzi_console.lca_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.lca_assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.lca_assessments USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.lca_assessments TO nzi_console_app;

CREATE TABLE nzi_console.lca_assessment_datasets (
  organisation_id text NOT NULL,
  assessment_id text NOT NULL,
  dataset_id text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, assessment_id, dataset_id),
  FOREIGN KEY (organisation_id, assessment_id) REFERENCES nzi_console.lca_assessments(organisation_id, assessment_id) ON DELETE CASCADE
);
ALTER TABLE nzi_console.lca_assessment_datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.lca_assessment_datasets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.lca_assessment_datasets USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, DELETE ON nzi_console.lca_assessment_datasets TO nzi_console_app;

CREATE TABLE nzi_console.lca_line_items (
  organisation_id text NOT NULL,
  line_item_id text NOT NULL,
  assessment_id text NOT NULL,
  component_id text,
  module_code text NOT NULL REFERENCES nzi_console.lca_modules(module_code),
  line_label text NOT NULL CHECK (nullif(trim(line_label), '') IS NOT NULL),
  material_category_id text,
  quantity double precision NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  unit text NOT NULL DEFAULT 'kg',
  origin_country text,
  energy_kwh double precision CHECK (energy_kwh IS NULL OR energy_kwh >= 0),
  end_of_life_route text CHECK (end_of_life_route IS NULL OR end_of_life_route IN ('landfill','recycling','incineration','compost','reuse','other')),
  factor_source text NOT NULL DEFAULT 'unmapped' CHECK (factor_source IN ('dataset','client','manual','unmapped')),
  dataset_id text,
  factor_id text,
  client_factor_id text,
  factor_value double precision CHECK (factor_value IS NULL OR factor_value >= 0),
  factor_unit text,
  factor_label text,
  factor_match_confidence double precision CHECK (factor_match_confidence IS NULL OR (factor_match_confidence >= 0 AND factor_match_confidence <= 1)),
  data_quality text NOT NULL DEFAULT 'secondary' CHECK (data_quality IN ('primary','secondary','proxy','estimated')),
  is_gap_filled boolean NOT NULL DEFAULT false,
  gap_fill_method text,
  is_placeholder boolean NOT NULL DEFAULT false,
  transport_kgco2e double precision NOT NULL DEFAULT 0,
  calculated_kgco2e double precision,
  lineage_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(lineage_json) = 'array'),
  notes text NOT NULL DEFAULT '',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz,
  PRIMARY KEY (organisation_id, line_item_id),
  FOREIGN KEY (organisation_id, assessment_id) REFERENCES nzi_console.lca_assessments(organisation_id, assessment_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, component_id) REFERENCES nzi_console.lca_components(organisation_id, component_id),
  FOREIGN KEY (organisation_id, material_category_id) REFERENCES nzi_console.lca_material_categories(organisation_id, material_category_id),
  CONSTRAINT lca_line_item_factor_shape CHECK (
    (factor_source = 'unmapped'  AND factor_id IS NULL AND client_factor_id IS NULL) OR
    (factor_source = 'dataset'   AND factor_id IS NOT NULL AND dataset_id IS NOT NULL AND client_factor_id IS NULL) OR
    (factor_source = 'client'    AND client_factor_id IS NOT NULL AND factor_id IS NULL) OR
    (factor_source = 'manual'    AND factor_value IS NOT NULL)
  )
);
CREATE INDEX lca_line_items_assessment_idx ON nzi_console.lca_line_items(organisation_id, assessment_id, module_code);
CREATE INDEX lca_line_items_component_idx ON nzi_console.lca_line_items(organisation_id, component_id);
ALTER TABLE nzi_console.lca_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.lca_line_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.lca_line_items USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON nzi_console.lca_line_items TO nzi_console_app;

CREATE TABLE nzi_console.lca_transport_legs (
  organisation_id text NOT NULL,
  leg_id text NOT NULL,
  line_item_id text NOT NULL,
  leg_order integer NOT NULL CHECK (leg_order >= 0),
  from_label text NOT NULL DEFAULT '',
  from_lat double precision,
  from_lng double precision,
  to_label text NOT NULL DEFAULT '',
  to_lat double precision,
  to_lng double precision,
  mode text NOT NULL CHECK (mode IN ('road_hgv','road_van','rail','sea','air','inland_water','other')),
  distance_km double precision NOT NULL DEFAULT 0 CHECK (distance_km >= 0),
  distance_source text NOT NULL DEFAULT 'manual' CHECK (distance_source IN ('geocoded','manual')),
  factor_source text NOT NULL DEFAULT 'unmapped' CHECK (factor_source IN ('dataset','client','manual','unmapped')),
  dataset_id text,
  factor_id text,
  factor_value double precision CHECK (factor_value IS NULL OR factor_value >= 0),
  calculated_kgco2e double precision,
  notes text NOT NULL DEFAULT '',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, leg_id),
  FOREIGN KEY (organisation_id, line_item_id) REFERENCES nzi_console.lca_line_items(organisation_id, line_item_id) ON DELETE CASCADE,
  UNIQUE (organisation_id, line_item_id, leg_order)
);
CREATE INDEX lca_transport_legs_line_idx ON nzi_console.lca_transport_legs(organisation_id, line_item_id, leg_order);
ALTER TABLE nzi_console.lca_transport_legs ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.lca_transport_legs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.lca_transport_legs USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON nzi_console.lca_transport_legs TO nzi_console_app;

COMMENT ON TABLE nzi_console.lca_assessments IS 'One LCA/PCF assessment; several per job (Model Register). PCF is a preset (standard ISO 14067, cradle-to-gate). review_status bound to reviewed_version (NZC-055).';
COMMENT ON TABLE nzi_console.lca_line_items IS 'Flat LCA inventory, one row per EN 15804 module (NZC-054). Factor mapping via shared emission_factors / client_factors (NZC-056).';
COMMENT ON TABLE nzi_console.lca_transport_legs IS 'Ordered geocoded legs on a transport-module line item; the line caches transport_kgco2e = sum(legs).';

COMMIT;
