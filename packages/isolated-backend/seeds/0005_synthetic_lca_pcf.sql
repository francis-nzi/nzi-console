BEGIN;
SET search_path TO nzi_console,public;

-- Track C — LCA/PCF reference module (slice 2, Inventory). Seed data for the
-- two LCA/PCF jobs already in 0001_synthetic_demo.sql (job '714' = Verdant
-- Foods "Recyclable food packaging" LCA; job '715' = Quaymed Devices "QMD
-- Diagnostic Unit" PCF) so the module is visible on staging behind
-- `job-module-lca` and the e2e spec never has to skip for want of a seed job.
-- Flavour matches jobs.detail_json on both rows exactly (boundary, functional
-- unit, bomLines/readinessPct framing) — no new job rows are created here.

-- ── Material categories (org-scoped) ───────────────────────────────────────
INSERT INTO lca_material_categories(organisation_id,material_category_id,name,description,created_by) VALUES
  ('demo-nzi-console','mc-polymers','Polymers','Plastics and polymer composites','demo-admin'),
  ('demo-nzi-console','mc-packaging','Packaging materials','Board, paper and secondary packaging','demo-admin'),
  ('demo-nzi-console','mc-chemicals','Chemicals & adhesives','Adhesives, inks, coatings and process chemicals','demo-admin'),
  ('demo-nzi-console','mc-electronics','Electronics','PCBs, batteries and electronic components','demo-admin')
ON CONFLICT(organisation_id,material_category_id) DO NOTHING;

-- ── Component library — one client-scoped, one global, per NZC-053 ────────
INSERT INTO lca_components(organisation_id,component_id,client_id,component_code,description,material_category_id,default_unit_mass,default_unit,origin_country,supplier_name,created_by) VALUES
  ('demo-nzi-console','cmp-rpet-tray','verdant-foods','VP-TRAY','rPET food tray, 30% recycled','mc-polymers',31.5,'kg','GB','Circular Polymer UK','demo-admin'),
  ('demo-nzi-console','cmp-corrugated-box',NULL,'STD-BOX','Corrugated board distribution carton','mc-packaging',NULL,'kg',NULL,NULL,'demo-admin'),
  ('demo-nzi-console','cmp-abs-enclosure','quaymed-devices','QMD-ENC','ABS enclosure, injection-moulded','mc-polymers',2.4,'kg','DE','Nordic Precision Moulding','demo-admin')
ON CONFLICT(organisation_id,component_id) DO NOTHING;

-- ── Model Register: job 714 (Verdant Foods, LCA) ───────────────────────────
INSERT INTO lca_assessments(organisation_id,assessment_id,job_id,client_id,assessment_type,name,sku,functional_unit_value,functional_unit_unit,confirmed_quantity,confirmed_quantity_unit,lifecycle_boundary,included_modules,standard,reference_year,geography,version,created_by)
VALUES('demo-nzi-console','assess-714-6l','714','verdant-foods','product','Recyclable food pack — 6L variant','VP-6L',1000,'filled packs',31.5,'kg','cradle_to_grave','["A1","A2","A3","A4","C3","C4"]'::jsonb,'ISO 14040 / ISO 14044',2025,'GB',1,'demo-admin')
ON CONFLICT(organisation_id,assessment_id) DO NOTHING;

INSERT INTO lca_line_items(organisation_id,line_item_id,assessment_id,component_id,module_code,line_label,material_category_id,quantity,unit,origin_country,factor_source,dataset_id,factor_id,factor_unit,factor_label,factor_match_confidence,data_quality,calculated_kgco2e,created_by) VALUES
  ('demo-nzi-console','714-6l-tray','assess-714-6l','cmp-rpet-tray','A1','rPET tray','mc-polymers',31.5,'kg','GB','dataset','ds-ecoinvent-310','f-rpet','kg CO2e/kg','Recycled PET granulate',0.94,'primary',52.9,'demo-admin'),
  ('demo-nzi-console','714-6l-box','assess-714-6l','cmp-corrugated-box','A3','Corrugated distribution carton','mc-packaging',0.22,'kg','GB','unmapped',NULL,NULL,NULL,NULL,NULL,'estimated',NULL,'demo-admin'),
  ('demo-nzi-console','714-6l-adhesive','assess-714-6l',NULL,'A1','Food-grade adhesive','mc-chemicals',0.35,'kg',NULL,'unmapped',NULL,NULL,NULL,NULL,NULL,'estimated',NULL,'demo-admin')
ON CONFLICT(organisation_id,line_item_id) DO NOTHING;

INSERT INTO lca_line_items(organisation_id,line_item_id,assessment_id,module_code,line_label,quantity,unit,factor_source,factor_value,factor_unit,data_quality,is_gap_filled,gap_fill_method,calculated_kgco2e,created_by) VALUES
  ('demo-nzi-console','714-6l-label-ink','assess-714-6l','A1','Label ink',0.06,'kg','manual',3.1,'kg CO2e/kg','proxy',true,'Category-average printing ink, DEFRA 2025',0.19,'demo-admin')
ON CONFLICT(organisation_id,line_item_id) DO NOTHING;

-- placeholder / assembly-grouping row — excluded from the total
INSERT INTO lca_line_items(organisation_id,line_item_id,assessment_id,module_code,line_label,quantity,unit,factor_source,data_quality,is_placeholder,created_by) VALUES
  ('demo-nzi-console','714-6l-assembly','assess-714-6l','A3','— Secondary packaging assembly —',0,'kg','unmapped','estimated',true,'demo-admin')
ON CONFLICT(organisation_id,line_item_id) DO NOTHING;

-- ── PCF preset: job 715 (Quaymed Devices, ISO 14067 cradle-to-gate) ────────
INSERT INTO lca_assessments(organisation_id,assessment_id,job_id,client_id,assessment_type,name,sku,functional_unit_value,functional_unit_unit,confirmed_quantity,confirmed_quantity_unit,lifecycle_boundary,included_modules,standard,reference_year,geography,version,created_by)
VALUES('demo-nzi-console','assess-715-pcf','715','quaymed-devices','product','QMD Diagnostic Unit — Product Carbon Footprint','QMD-1',1,'device over service life',3.92,'kg','cradle_to_gate','["A1","A2","A3"]'::jsonb,'ISO 14067',2026,'DE',1,'demo-admin')
ON CONFLICT(organisation_id,assessment_id) DO NOTHING;

INSERT INTO lca_line_items(organisation_id,line_item_id,assessment_id,component_id,module_code,line_label,material_category_id,quantity,unit,factor_source,dataset_id,factor_id,factor_unit,factor_label,factor_match_confidence,data_quality,calculated_kgco2e,created_by) VALUES
  ('demo-nzi-console','715-housing','assess-715-pcf','cmp-abs-enclosure','A1','ABS enclosure','mc-polymers',2.4,'kg','dataset','ds-ecoinvent-310','f-abs','kg CO2e/kg','ABS production, Europe',0.91,'primary',9.8,'demo-admin'),
  ('demo-nzi-console','715-pcb','assess-715-pcf',NULL,'A1','Control PCB','mc-electronics',0.62,'kg','dataset','ds-ecoinvent-310','f-pwb','kg CO2e/kg','Printed wiring board',0.72,'secondary',61.4,'demo-admin'),
  ('demo-nzi-console','715-battery','assess-715-pcf',NULL,'A1','Lithium battery pack','mc-electronics',0.9,'kg','unmapped',NULL,NULL,NULL,NULL,NULL,'estimated',NULL,'demo-admin')
ON CONFLICT(organisation_id,line_item_id) DO NOTHING;

COMMIT;
