BEGIN;
SET search_path TO nzi_console,public;

INSERT INTO emission_factor_datasets
  (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence,synthetic)
VALUES
  ('demo-nzi-console','synthetic-gb-2026','Synthetic GB activity factors','2026 demo v1','2026-01-01','2026-12-31','GB','active','NZI Console test fixture','Demonstration only',true),
  ('demo-nzi-console','synthetic-global-2026','Synthetic global spend factors','2026 demo v1','2026-01-01','2026-12-31','GLOBAL','active','NZI Console test fixture','Demonstration only',true),
  ('demo-nzi-console','synthetic-us-2026','Synthetic US activity factors','2026 demo v1','2026-01-01','2026-12-31','US','active','NZI Console test fixture','Demonstration only',true)
ON CONFLICT (organisation_id,dataset_id) DO UPDATE SET name=EXCLUDED.name,version=EXCLUDED.version;

INSERT INTO emission_factors
  (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
VALUES
  ('demo-nzi-console','synthetic-gb-2026','diesel-demo','Diesel — demonstration factor','litres',2.500000,ARRAY['1','3']),
  ('demo-nzi-console','synthetic-gb-2026','gas-demo','Natural gas — demonstration factor','kWh',0.180000,ARRAY['1']),
  ('demo-nzi-console','synthetic-gb-2026','electricity-demo','UK electricity — demonstration factor','kWh',0.300000,ARRAY['2']),
  ('demo-nzi-console','synthetic-gb-2026','freight-demo','Road freight — demonstration factor','t·km',0.200000,ARRAY['3']),
  ('demo-nzi-console','synthetic-global-2026','spend-demo','Purchased goods spend — demonstration factor','GBP',0.150000,ARRAY['3']),
  ('demo-nzi-console','synthetic-us-2026','electricity-us-demo','US electricity — demonstration factor','kWh',0.400000,ARRAY['2'])
ON CONFLICT (organisation_id,dataset_id,factor_id) DO UPDATE SET label=EXCLUDED.label,activity_unit=EXCLUDED.activity_unit,kgco2e_per_unit=EXCLUDED.kgco2e_per_unit,scopes=EXCLUDED.scopes;

INSERT INTO job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by)
SELECT c.organisation_id,c.job_id,d.dataset_id,'automatic','Matched reporting period and geography.','system'
FROM job_emissions_config c JOIN emission_factor_datasets d ON d.organisation_id=c.organisation_id
 AND d.status='active' AND d.valid_from<=c.reporting_from AND d.valid_to>=c.reporting_to
 AND d.country_code IN (c.country_code,'GLOBAL')
ON CONFLICT (organisation_id,job_id,dataset_id) DO NOTHING;

COMMIT;
