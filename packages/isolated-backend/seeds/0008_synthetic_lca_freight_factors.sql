BEGIN;
SET search_path TO nzi_console,public;

-- Track C — LCA engine parity correction. Adds the live app's freight default
-- factor shortlist (docs/_handoff_LCA_engine_parity.md §8 — 13 tonne.km
-- factors across road/rail/sea/air) to the synthetic GB dataset under their
-- cross-dataset `original_id`s, and re-points the seeded 714/715 transport
-- legs at real dataset factors so "Recalculate" exercises the corrected
-- tonne.km transport maths (§1), not the placeholder path.
-- kgCO2e-per-tonne.km values are demonstration figures (DEFRA-ish orders of
-- magnitude), not the live dataset's exact numbers.

INSERT INTO emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES
  ('demo-nzi-console','synthetic-gb-2026','27_303_3102_14_1','Van (up to 3.5t) Diesel — freight','tonne.km',0.550000,ARRAY['3']),
  ('demo-nzi-console','synthetic-gb-2026','27_304_3140_14_1','HGV (All Diesel), Average Laden — freight','tonne.km',0.100000,ARRAY['3']),
  ('demo-nzi-console','synthetic-gb-2026','27_306_3140_14_1','HGV Refrigerated (All Diesel), Average Laden — freight','tonne.km',0.120000,ARRAY['3']),
  ('demo-nzi-console','synthetic-gb-2026','27_315_3151_14_1','Freight Train — freight','tonne.km',0.028000,ARRAY['3']),
  ('demo-nzi-console','synthetic-gb-2026','27_319_3197_14_1','Tanker — Crude — freight','tonne.km',0.004000,ARRAY['3']),
  ('demo-nzi-console','synthetic-gb-2026','27_319_3208_14_1','Tanker — Chemical — freight','tonne.km',0.005000,ARRAY['3']),
  ('demo-nzi-console','synthetic-gb-2026','27_319_3211_14_1','Tanker — LNG — freight','tonne.km',0.010000,ARRAY['3']),
  ('demo-nzi-console','synthetic-gb-2026','27_319_3214_14_1','Tanker — LPG — freight','tonne.km',0.008000,ARRAY['3']),
  ('demo-nzi-console','synthetic-gb-2026','27_320_3221_14_1','Cargo Ship — Bulk Carrier — freight','tonne.km',0.003000,ARRAY['3']),
  ('demo-nzi-console','synthetic-gb-2026','27_320_3228_14_1','Cargo Ship — General Cargo — freight','tonne.km',0.011000,ARRAY['3']),
  ('demo-nzi-console','synthetic-gb-2026','27_320_3235_14_1','Cargo Ship — Container Ship — freight','tonne.km',0.016000,ARRAY['3']),
  ('demo-nzi-console','synthetic-gb-2026','27_317_3152_14_1','Freight Flight — Domestic (to/from UK)','tonne.km',1.600000,ARRAY['3']),
  ('demo-nzi-console','synthetic-gb-2026','27_317_3154_14_1','Freight Flight — Short-Haul (to/from UK)','tonne.km',1.000000,ARRAY['3']),
  ('demo-nzi-console','synthetic-gb-2026','27_317_3158_14_1','Freight Flight — International (to/from non-UK)','tonne.km',0.550000,ARRAY['3'])
ON CONFLICT (organisation_id,dataset_id,factor_id) DO UPDATE SET label=EXCLUDED.label,activity_unit=EXCLUDED.activity_unit,kgco2e_per_unit=EXCLUDED.kgco2e_per_unit,scopes=EXCLUDED.scopes;

-- Re-point the seeded transport legs at real dataset freight factors.
UPDATE nzi_console.lca_transport_legs SET factor_source='dataset',dataset_id='synthetic-gb-2026',factor_id='27_304_3140_14_1'
  WHERE organisation_id='demo-nzi-console' AND leg_id IN ('714-6l-leg-1','714-6l-leg-3');
UPDATE nzi_console.lca_transport_legs SET factor_source='dataset',dataset_id='synthetic-gb-2026',factor_id='27_320_3235_14_1'
  WHERE organisation_id='demo-nzi-console' AND leg_id='714-6l-leg-2';
UPDATE nzi_console.lca_transport_legs SET factor_source='dataset',dataset_id='synthetic-gb-2026',factor_id='27_303_3102_14_1'
  WHERE organisation_id='demo-nzi-console' AND leg_id='715-leg-1';

COMMIT;
