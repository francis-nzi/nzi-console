BEGIN;
SET search_path TO nzi_console,public;

-- Track C — LCA/PCF reference module (slice 3, Transport legs). Adds one
-- transport-module (A4) line item to the existing seed assessment
-- assess-714-6l, with a multi-leg geocoded journey (factory -> port -> port
-- -> pack site) mirroring the illustrative worst-case fixture in
-- @nzi/mock-data/lcaFidelity.ts, so the real seed and the fixture tell the
-- same story. Leg-level `calculated_kgco2e` stays null — honest, pending the
-- L4 calc engine — so the line item's cached `transport_kgco2e` is left at
-- its schema default of 0, not backfilled here.

INSERT INTO lca_line_items(organisation_id,line_item_id,assessment_id,module_code,line_label,quantity,unit,factor_source,data_quality,created_by) VALUES
  ('demo-nzi-console','714-6l-inbound-transport','assess-714-6l','A4','Inbound tray shipment',31.5,'kg','unmapped','secondary','demo-admin')
ON CONFLICT(organisation_id,line_item_id) DO NOTHING;

INSERT INTO lca_transport_legs(organisation_id,leg_id,line_item_id,leg_order,from_label,from_lat,from_lng,to_label,to_lat,to_lng,mode,distance_km,distance_source,factor_source,created_by) VALUES
  ('demo-nzi-console','714-6l-leg-1','714-6l-inbound-transport',0,'Ningbo plant, CN',29.87,121.55,'Ningbo port, CN',29.95,121.85,'road_hgv',42,'geocoded','unmapped','demo-admin'),
  ('demo-nzi-console','714-6l-leg-2','714-6l-inbound-transport',1,'Ningbo port, CN',29.95,121.85,'Felixstowe port, UK',51.96,1.35,'sea',19600,'geocoded','unmapped','demo-admin'),
  ('demo-nzi-console','714-6l-leg-3','714-6l-inbound-transport',2,'Felixstowe port, UK',51.96,1.35,'Leeds pack site, UK',53.8,-1.55,'road_hgv',310,'geocoded','unmapped','demo-admin')
ON CONFLICT(organisation_id,leg_id) DO NOTHING;

-- job 715 (pcf, cradle-to-gate) includes A2 (transport to manufacturer) —
-- a single leg is enough to prove the model on a second job/family.
INSERT INTO lca_line_items(organisation_id,line_item_id,assessment_id,module_code,line_label,quantity,unit,factor_source,data_quality,created_by) VALUES
  ('demo-nzi-console','715-inbound-transport','assess-715-pcf','A2','Inbound component shipment',3.92,'kg','unmapped','secondary','demo-admin')
ON CONFLICT(organisation_id,line_item_id) DO NOTHING;

INSERT INTO lca_transport_legs(organisation_id,leg_id,line_item_id,leg_order,from_label,to_label,mode,distance_km,distance_source,factor_source,created_by) VALUES
  ('demo-nzi-console','715-leg-1','715-inbound-transport',0,'Component supplier, DE','QMD assembly site, DE','road_van',260,'manual','unmapped','demo-admin')
ON CONFLICT(organisation_id,leg_id) DO NOTHING;

COMMIT;
