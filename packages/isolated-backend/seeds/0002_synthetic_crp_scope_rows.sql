BEGIN;

SET search_path TO nzi_console, public;

-- Fictional activity data for the synthetic J000712 demonstrator only.
INSERT INTO job_scope_rows (
  organisation_id, scope_row_id, job_id, scope, source_label, quantity, unit,
  dataset_id, factor_id, factor_version, factor_label, quality_tier, calculated_tco2e,
  review_status, provenance_json, lineage_json
) VALUES
  ('demo-nzi-console','demo-712-diesel','712','1','Diesel — company vehicles',48200,'litres','defra-2024','diesel-average','2024 v1.2','DEFRA diesel average','measured',128.4,'approved','{"source":"Synthetic fuel invoices","dataset":"DEFRA 2024","asAt":"2026-08-25"}','[{"title":"Activity data captured","detail":"48,200 litres"},{"title":"Factor selected","detail":"DEFRA diesel average · 2024 v1.2"},{"title":"Emissions calculated","detail":"Synthetic demonstration result · 128.4 tCO2e"}]'),
  ('demo-nzi-console','demo-712-gas','712','1','Natural gas — heating',96000,'kWh','defra-2024','natural-gas','2024 v1.2','DEFRA natural gas','measured',17.6,'approved','{"source":"Synthetic meter data","dataset":"DEFRA 2024","asAt":"2026-08-25"}','[{"title":"Activity data captured","detail":"96,000 kWh"},{"title":"Factor selected","detail":"DEFRA natural gas · 2024 v1.2"},{"title":"Emissions calculated","detail":"Synthetic demonstration result · 17.6 tCO2e"}]'),
  ('demo-nzi-console','demo-712-fgas','712','1','Refrigerant R410a top-up',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'pending','{"source":"Synthetic source register","asAt":"2026-08-25"}','[]'),
  ('demo-nzi-console','demo-712-electricity','712','2','Purchased electricity',312,'MWh','desnz-2024','uk-grid','2024 v1.0','DESNZ UK grid average','measured',96.1,'approved','{"source":"Synthetic electricity meter","dataset":"DESNZ 2024","asAt":"2026-08-25"}','[{"title":"Activity data captured","detail":"312 MWh"},{"title":"Factor selected","detail":"DESNZ UK grid · 2024 v1.0"},{"title":"Emissions calculated","detail":"Synthetic demonstration result · 96.1 tCO2e"}]'),
  ('demo-nzi-console','demo-712-air','712','3.6','Business travel — air',NULL,NULL,'defra-2024','air-travel','2024 v1.2','DEFRA air travel',NULL,NULL,'pending','{"source":"Synthetic travel register","dataset":"DEFRA 2024","asAt":"2026-08-25"}','[{"title":"Factor selected","detail":"DEFRA air travel · 2024 v1.2"}]'),
  ('demo-nzi-console','demo-712-freight','712','3.4','Upstream freight — road',1900000,'t·km','defra-2024','hgv-average','2024 v1.2','DEFRA HGV average','estimated',412.7,'pending','{"source":"Synthetic modelled freight distance","dataset":"DEFRA 2024","asAt":"2026-08-25"}','[{"title":"Activity estimated","detail":"1,900,000 t·km"},{"title":"Factor selected","detail":"DEFRA HGV average · 2024 v1.2"},{"title":"Emissions calculated","detail":"Synthetic demonstration result · 412.7 tCO2e"}]'),
  ('demo-nzi-console','demo-712-spend','712','3.1','Purchased goods — spend',4100000,'GBP','ceda-2025','sector-average','2025 v1.0','CEDA sector average','spend-based',686.3,'pending','{"source":"Synthetic ledger spend","dataset":"CEDA 2025","asAt":"2026-08-25"}','[{"title":"Spend data captured","detail":"GBP 4,100,000"},{"title":"Factor selected","detail":"CEDA sector average · 2025 v1.0"},{"title":"Emissions calculated","detail":"Synthetic demonstration result · 686.3 tCO2e"}]'),
  ('demo-nzi-console','demo-712-commute','712','3.7','Employee commuting',210,'staff','defra-2024','commuting-blend','2024 v1.2','DEFRA commuting blend','survey',74.8,'approved','{"source":"Synthetic staff survey","dataset":"DEFRA 2024","asAt":"2026-08-25"}','[{"title":"Survey responses captured","detail":"210 staff"},{"title":"Factor selected","detail":"DEFRA commuting blend · 2024 v1.2"},{"title":"Emissions calculated","detail":"Synthetic demonstration result · 74.8 tCO2e"}]'),
  ('demo-nzi-console','demo-712-waste','712','3.5','Waste — landfill',12,'tonnes','defra-2024','landfill-mixed','2024 v1.2','DEFRA mixed landfill','estimated',2.1,'approved','{"source":"Synthetic waste transfer notes","dataset":"DEFRA 2024","asAt":"2026-08-25"}','[{"title":"Activity data captured","detail":"12 tonnes"},{"title":"Factor selected","detail":"DEFRA mixed landfill · 2024 v1.2"},{"title":"Emissions calculated","detail":"Synthetic demonstration result · 2.1 tCO2e"}]')
ON CONFLICT (organisation_id, scope_row_id) DO NOTHING;

COMMIT;
