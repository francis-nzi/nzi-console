BEGIN;
SET search_path TO nzi_console,public;

-- Track C — LCA/PCF reference module (slice 5, Scenarios). A baseline and one
-- what-if scenario on the seeded 714 6L assessment, with a single multiplier
-- rule (15% less polymer at A1), so the comparison view has something to
-- show on staging.

INSERT INTO lca_scenarios(organisation_id,scenario_id,assessment_id,name,description,is_baseline,created_by) VALUES
  ('demo-nzi-console','scn-714-6l-base','assess-714-6l','Current design','As-inventoried baseline',true,'demo-admin'),
  ('demo-nzi-console','scn-714-6l-light','assess-714-6l','Lightweight tray','15% less polymer at raw-material supply',false,'demo-admin')
ON CONFLICT(organisation_id,scenario_id) DO NOTHING;

INSERT INTO lca_scenario_multipliers(organisation_id,multiplier_id,scenario_id,module_code,material_category_id,component_id,multiplier) VALUES
  ('demo-nzi-console','mul-714-6l-light-1','scn-714-6l-light','A1','mc-polymers',NULL,0.85)
ON CONFLICT(organisation_id,multiplier_id) DO NOTHING;

COMMIT;
