BEGIN;

-- Job-family model batch, Phase 0 — LCA what-if scenarios (schema only) and
-- content-addressed result snapshots (MODEL_FIDELITY_JOB_FAMILIES.md §2, §6).
-- Additive, inert until the module reads it. Scenarios mirror the live nzi_pro
-- Phase-1 shape: engine + UI wired later, so this stays additive-only.

CREATE TABLE nzi_console.lca_scenarios (
  organisation_id text NOT NULL,
  scenario_id text NOT NULL,
  assessment_id text NOT NULL,
  name text NOT NULL CHECK (nullif(trim(name), '') IS NOT NULL),
  description text NOT NULL DEFAULT '',
  is_baseline boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, scenario_id),
  FOREIGN KEY (organisation_id, assessment_id) REFERENCES nzi_console.lca_assessments(organisation_id, assessment_id) ON DELETE CASCADE
);
CREATE INDEX lca_scenarios_assessment_idx ON nzi_console.lca_scenarios(organisation_id, assessment_id);
CREATE UNIQUE INDEX lca_scenarios_one_baseline_idx ON nzi_console.lca_scenarios(organisation_id, assessment_id) WHERE is_baseline;
ALTER TABLE nzi_console.lca_scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.lca_scenarios FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.lca_scenarios USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON nzi_console.lca_scenarios TO nzi_console_app;

-- A multiplier is keyed by module + an optional material category OR component
-- (a component override is more specific than a category-wide one).
CREATE TABLE nzi_console.lca_scenario_multipliers (
  organisation_id text NOT NULL,
  multiplier_id text NOT NULL,
  scenario_id text NOT NULL,
  module_code text NOT NULL REFERENCES nzi_console.lca_modules(module_code),
  material_category_id text,
  component_id text,
  multiplier double precision NOT NULL DEFAULT 1.0 CHECK (multiplier >= 0),
  PRIMARY KEY (organisation_id, multiplier_id),
  FOREIGN KEY (organisation_id, scenario_id) REFERENCES nzi_console.lca_scenarios(organisation_id, scenario_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, material_category_id) REFERENCES nzi_console.lca_material_categories(organisation_id, material_category_id),
  FOREIGN KEY (organisation_id, component_id) REFERENCES nzi_console.lca_components(organisation_id, component_id),
  CONSTRAINT lca_multiplier_target_shape CHECK (NOT (material_category_id IS NOT NULL AND component_id IS NOT NULL))
);
CREATE INDEX lca_scenario_multipliers_scenario_idx ON nzi_console.lca_scenario_multipliers(organisation_id, scenario_id);
ALTER TABLE nzi_console.lca_scenario_multipliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.lca_scenario_multipliers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.lca_scenario_multipliers USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON nzi_console.lca_scenario_multipliers TO nzi_console_app;

-- Calculation output — content-addressed, the reviewed artefact an LCA report is
-- built from (same discipline as reviewed_crp_snapshots).
CREATE TABLE nzi_console.lca_result_snapshots (
  organisation_id text NOT NULL,
  snapshot_id text NOT NULL,
  assessment_id text NOT NULL,
  scenario_id text,
  assessment_version integer NOT NULL,
  data_hash text NOT NULL,
  total_tco2e double precision NOT NULL DEFAULT 0,
  module_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(module_breakdown) = 'array'),
  hotspots jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(hotspots) = 'array'),
  mass_reconciliation jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(mass_reconciliation) = 'object'),
  notes text NOT NULL DEFAULT '',
  calculated_by text NOT NULL,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, snapshot_id),
  FOREIGN KEY (organisation_id, assessment_id) REFERENCES nzi_console.lca_assessments(organisation_id, assessment_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, scenario_id) REFERENCES nzi_console.lca_scenarios(organisation_id, scenario_id) ON DELETE SET NULL
);
CREATE INDEX lca_result_snapshots_assessment_idx ON nzi_console.lca_result_snapshots(organisation_id, assessment_id, calculated_at DESC);
ALTER TABLE nzi_console.lca_result_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.lca_result_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.lca_result_snapshots USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT ON nzi_console.lca_result_snapshots TO nzi_console_app;

COMMENT ON TABLE nzi_console.lca_result_snapshots IS 'Content-addressed LCA calculation output; module_breakdown / hotspots / mass_reconciliation. The reviewed artefact an LCA report cites.';

COMMIT;
