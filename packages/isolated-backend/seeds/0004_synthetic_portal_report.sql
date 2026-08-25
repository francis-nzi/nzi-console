BEGIN;
SET search_path TO nzi_console,public;

INSERT INTO jobs(organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,owner_name,start_date,due_date,progress_percent,detail_json)
VALUES('demo-nzi-console','711','bushy-tails',711,'crp','2023 Carbon Reduction Plan','complete','Report & publish',2023,'A. Shaw','2024-01-08','2024-03-29',100,'{"kind":"crp","reportingPeriod":"1 Jan–31 Dec 2023","includedScopes":["1","2","3"],"reviewedRows":3,"totalRows":3}')
ON CONFLICT(organisation_id,job_id) DO NOTHING;

INSERT INTO job_scope_rows(organisation_id,scope_row_id,job_id,scope,source_label,quantity,unit,factor_version,factor_label,quality_tier,calculated_tco2e,review_status,reviewed_row_version,reviewed_by,reviewed_at,reviewer_note,provenance_json,lineage_json,enabled)
VALUES
('demo-nzi-console','demo-711-s1','711','1','2023 direct emissions',1,'annual total','2023 synthetic','Reviewed annual total','measured',162.0,'approved',1,'demo-reviewer',now(),'Synthetic predecessor reviewed for year-on-year demonstration','{"source":"Synthetic reviewed predecessor"}','[{"title":"Independent review","detail":"Synthetic 2023 Scope 1 total"}]',true),
('demo-nzi-console','demo-711-s2','711','2','2023 electricity emissions',1,'annual total','2023 synthetic','Reviewed annual total','measured',104.0,'approved',1,'demo-reviewer',now(),'Synthetic predecessor reviewed for year-on-year demonstration','{"source":"Synthetic reviewed predecessor"}','[{"title":"Independent review","detail":"Synthetic 2023 Scope 2 total"}]',true),
('demo-nzi-console','demo-711-s3','711','3','2023 value-chain emissions',1,'annual total','2023 synthetic','Reviewed annual total','estimated',1260.0,'approved',1,'demo-reviewer',now(),'Synthetic predecessor reviewed for year-on-year demonstration','{"source":"Synthetic reviewed predecessor"}','[{"title":"Independent review","detail":"Synthetic 2023 Scope 3 total"}]',true)
ON CONFLICT(organisation_id,scope_row_id) DO NOTHING;

INSERT INTO client_sites(organisation_id,site_id,client_id,name,created_by)
VALUES('demo-nzi-console','bushy-manchester','bushy-tails','Manchester operations','demo-admin')
ON CONFLICT(organisation_id,site_id) DO NOTHING;
INSERT INTO purchased_goods_categories(organisation_id,category_id,client_id,name,created_by)
VALUES('demo-nzi-console','bushy-goods-services','bushy-tails','Goods and services','demo-admin')
ON CONFLICT(organisation_id,category_id) DO NOTHING;

UPDATE job_scope_rows SET enabled=false WHERE organisation_id='demo-nzi-console' AND job_id='712' AND scope_row_id IN('demo-712-air','demo-712-fgas');
UPDATE job_scope_rows SET site_id='bushy-manchester' WHERE organisation_id='demo-nzi-console' AND job_id='712' AND enabled=true;
UPDATE job_scope_rows SET purchased_goods_category_id='bushy-goods-services' WHERE organisation_id='demo-nzi-console' AND scope_row_id='demo-712-spend';
UPDATE job_scope_rows SET review_status='approved',reviewed_row_version=version,reviewed_by='demo-reviewer',reviewed_at=now(),reviewer_note='Synthetic evidence independently reviewed for portal demonstration'
WHERE organisation_id='demo-nzi-console' AND job_id='712' AND scope_row_id IN('demo-712-freight','demo-712-spend') AND review_status='pending';

INSERT INTO scope_row_review_history(organisation_id,review_event_id,job_id,scope_row_id,row_version,decision,reviewer_id,reviewer_note)
VALUES
('demo-nzi-console','demo-review-712-freight','712','demo-712-freight',1,'approved','demo-reviewer','Synthetic evidence independently reviewed for portal demonstration'),
('demo-nzi-console','demo-review-712-spend','712','demo-712-spend',1,'approved','demo-reviewer','Synthetic evidence independently reviewed for portal demonstration')
ON CONFLICT(organisation_id,review_event_id) DO NOTHING;

INSERT INTO job_emissions_targets(organisation_id,job_id,baseline_year,baseline_tco2e,interim_year,interim_reduction_percent,net_zero_year,version,updated_by)
VALUES('demo-nzi-console','712',2023,1526,2030,50,2045,1,'demo-admin')
ON CONFLICT(organisation_id,job_id) DO NOTHING;
INSERT INTO job_intensity_targets(organisation_id,job_id,metric,denominator_unit,reporting_denominator,baseline_year,baseline_intensity,interim_year,interim_reduction_percent,net_zero_year,version,updated_by)
VALUES('demo-nzi-console','712','turnover','£m turnover',12.5,2023,122.08,2030,50,2045,1,'demo-admin')
ON CONFLICT(organisation_id,job_id) DO NOTHING;

COMMIT;
