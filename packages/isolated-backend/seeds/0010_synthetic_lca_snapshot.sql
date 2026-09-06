BEGIN;
SET search_path TO nzi_console,public;

-- Track C — LCA/PCF reference module (slice 7, Report). A frozen, approved
-- result snapshot for the seeded 714 6L assessment so the LCA report page
-- and its e2e have an artefact to open without first driving the whole
-- calculate → approve → freeze chain by hand. Figures are internally
-- consistent (module breakdown sums to the total; hotspots ≤ total); the
-- data_hash is a demonstrator string (a real freeze recomputes it).

UPDATE nzi_console.lca_assessments
   SET total_tco2e = 0.0643, last_calculated_at = '2026-09-05T09:00:00Z',
       review_status = 'approved', reviewed_version = version, reviewed_by = 'demo-reviewer',
       reviewed_at = '2026-09-05T10:00:00Z', reviewer_note = 'Independently reviewed against the mass reconciliation and hotspot check.'
 WHERE organisation_id = 'demo-nzi-console' AND assessment_id = 'assess-714-6l';

INSERT INTO nzi_console.lca_result_snapshots
  (organisation_id, snapshot_id, assessment_id, assessment_version, data_hash, total_tco2e,
   module_breakdown, hotspots, mass_reconciliation, factor_sets, calculated_by, calculated_at)
VALUES (
  'demo-nzi-console', 'snap-714-6l-demo', 'assess-714-6l',
  (SELECT version FROM nzi_console.lca_assessments WHERE organisation_id='demo-nzi-console' AND assessment_id='assess-714-6l'),
  'sha256:demo-frozen-lca-714-6l-signed-off', 0.0643,
  '[{"moduleCode":"A1","tco2e":0.0531},{"moduleCode":"A3","tco2e":0.0002},{"moduleCode":"A4","tco2e":0.011}]'::jsonb,
  '[{"lineItemId":"714-6l-tray","label":"rPET tray","moduleCode":"A1","tco2e":0.0529,"sharePct":82},
    {"lineItemId":"714-6l-inbound-transport","label":"Inbound tray shipment","moduleCode":"A4","tco2e":0.011,"sharePct":17},
    {"lineItemId":"714-6l-label-ink","label":"Label ink","moduleCode":"A1","tco2e":0.0002,"sharePct":1}]'::jsonb,
  '{"confirmedMassKg":31.5,"capturedMassKg":31.91,"deltaPct":1.3}'::jsonb,
  '[{"label":"Recycled PET granulate — demonstration factor","version":"2026 demo v1","dataset":"Synthetic GB activity factors","originalId":"lca-rpet-demo"},
    {"label":"Corrugated board — demonstration factor","version":"2026 demo v1","dataset":"Synthetic GB activity factors","originalId":"lca-board-demo"},
    {"label":"Cargo Ship — Container Ship — freight","version":"2026 demo v1","dataset":"Synthetic GB activity factors","originalId":"27_320_3235_14_1"},
    {"label":"HGV (All Diesel), Average Laden — freight","version":"2026 demo v1","dataset":"Synthetic GB activity factors","originalId":"27_304_3140_14_1"},
    {"label":"Category-average printing ink, DEFRA 2025","version":"—","dataset":"Manual entry","originalId":"—"}]'::jsonb,
  'demo-admin', '2026-09-05T11:00:00Z'
)
ON CONFLICT (organisation_id, snapshot_id) DO NOTHING;

COMMIT;
