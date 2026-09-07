BEGIN;

-- S1 (data-entry UX review item 5) — Business Travel joins Company Vehicles and
-- Employee Commuting as a per-entity roll-up kind: many trips across modes
-- (flight / rail / hire car / taxi …) consolidate into one canonical Scope 3.6
-- row, the same mechanism the other two kinds already use. Widen the
-- source_type CHECK to admit 'travel'. Behind the NEXT_PUBLIC data-entry flag
-- `travel`.

ALTER TABLE nzi_console.job_emission_sources
  DROP CONSTRAINT IF EXISTS job_emission_sources_source_type_check;

ALTER TABLE nzi_console.job_emission_sources
  ADD CONSTRAINT job_emission_sources_source_type_check
  CHECK (source_type IN ('asset', 'vehicle', 'commuting', 'spend', 'travel'));

COMMIT;
