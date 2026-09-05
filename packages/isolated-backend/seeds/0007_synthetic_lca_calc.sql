BEGIN;
SET search_path TO nzi_console,public;

-- Track C — LCA/PCF reference module (slice 4, calc engine). The L2 seed
-- (0005) invented factor ids that don't exist in the synthetic factor
-- library, and the LCA jobs never got a `job_dataset_selections` row (that
-- insert is driven by CRP reporting-period config). This migration adds a
-- handful of kg-based material factors to the existing synthetic GB dataset,
-- selects that dataset for jobs 714/715, and re-points the seeded
-- dataset-mapped line items at the real ids — so "Recalculate" on staging
-- produces a genuine module breakdown / hotspots / total rather than zeros.
-- Transport legs stay unmapped on purpose, so the recalculated result
-- honestly shows a partially-mapped assessment.

INSERT INTO emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES
  ('demo-nzi-console','synthetic-gb-2026','lca-rpet-demo','Recycled PET granulate — demonstration factor','kg',1.680000,ARRAY['3']),
  ('demo-nzi-console','synthetic-gb-2026','lca-board-demo','Corrugated board — demonstration factor','kg',0.900000,ARRAY['3']),
  ('demo-nzi-console','synthetic-gb-2026','lca-abs-demo','ABS polymer — demonstration factor','kg',3.500000,ARRAY['3']),
  ('demo-nzi-console','synthetic-gb-2026','lca-pcb-demo','Printed circuit board — demonstration factor','kg',90.000000,ARRAY['3'])
ON CONFLICT (organisation_id,dataset_id,factor_id) DO UPDATE SET label=EXCLUDED.label,activity_unit=EXCLUDED.activity_unit,kgco2e_per_unit=EXCLUDED.kgco2e_per_unit,scopes=EXCLUDED.scopes;

INSERT INTO job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by) VALUES
  ('demo-nzi-console','714','synthetic-gb-2026','manual','LCA reference module demonstrator.','demo-admin'),
  ('demo-nzi-console','715','synthetic-gb-2026','manual','PCF reference module demonstrator.','demo-admin')
ON CONFLICT (organisation_id,job_id,dataset_id) DO NOTHING;

UPDATE nzi_console.lca_line_items SET dataset_id='synthetic-gb-2026',factor_id='lca-rpet-demo',factor_label='Recycled PET granulate — demonstration factor'
  WHERE organisation_id='demo-nzi-console' AND line_item_id='714-6l-tray';
UPDATE nzi_console.lca_line_items SET factor_source='dataset',dataset_id='synthetic-gb-2026',factor_id='lca-board-demo',factor_label='Corrugated board — demonstration factor',factor_unit='kg'
  WHERE organisation_id='demo-nzi-console' AND line_item_id='714-6l-box';
UPDATE nzi_console.lca_line_items SET dataset_id='synthetic-gb-2026',factor_id='lca-abs-demo',factor_label='ABS polymer — demonstration factor'
  WHERE organisation_id='demo-nzi-console' AND line_item_id='715-housing';
UPDATE nzi_console.lca_line_items SET dataset_id='synthetic-gb-2026',factor_id='lca-pcb-demo',factor_label='Printed circuit board — demonstration factor'
  WHERE organisation_id='demo-nzi-console' AND line_item_id='715-pcb';

COMMIT;
