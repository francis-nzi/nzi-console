-- 0165 The taxonomy additions the v7 re-ingest needs (RULING-v7-taxonomy-additions; NZC-168, amending NZC-046 and NZC-102).
--
-- One reference-data amendment to the governed input spec (0093), in three guarded parts:
--
-- ## T1 — a Scope 1 category: Other Stationary Fuels
-- `1.other-stationary-fuels`, kind `manual`, after Natural Gas. Combustion of a fuel other than natural gas in fixed plant —
-- diesel, gas oil, LPG, burning oil, bioenergy — had no native home (95 imported v7 rows, 20,159 t). Natural Gas is not widened:
-- it would mislabel diesel and oil. Its form is Natural Gas's, field for field (copied from the rows as they stand, not retyped),
-- with `accepted_units` litres, kWh and tonnes — what those rows are recorded in. It resolves the way Natural Gas does: free
-- search, no declared rules, the declarative switch off (the unit cannot pick the fuel — NZC-160 D3, the reason 0119 retired
-- `fuel-litres`).
--
-- ## T2 — GBP accepted on 3.4, 3.5, 3.6 and 3.9
-- Spend-based upstream freight, waste, business travel and downstream freight (75 imported rows, 4,447 t) are written in their
-- own category against v7's GBP-priced factor, instead of being pushed into 3.1 Purchased Goods. Acceptance only: the spend
-- *method* (net value / VAT / GL fields, the ledger, import, portal buckets) stays with 3.1/3.2/3.15 — `kind` is single-valued
-- and those paths are 3.1's; spend capture in these categories is a logged follow-up.
--
-- ## T3 — native units: tonne.km on 3.4, nights on 3.6, per FTE Working Hour on 3.7
-- 229 imported rows, 996 t. Each spelling is the loaded factors' own `activity_unit`, verbatim: count and the new `fte-time`
-- dimension are identity-only (unitCompatibility), so any other spelling would never reconcile with the factor's.
--
-- ## Guards — refuses unless the ground is exactly as surveyed (staging, 11 Oct 2026)
-- T1 refuses if the code already exists or Natural Gas is not the eleven-field category it was copied from. T2/T3 refuse unless
-- every touched row's units are exactly what the survey read, so a drifted spec stops the migration rather than being
-- overwritten. Units are appended — the first unit, the default offered, is unchanged. Each changed row is version-bumped and
-- stamped `migration:0165`. No `job_scope_rows` change: re-ingesting the v7 rows is a separate, governed change.

BEGIN;

DO $$
BEGIN
  -- ── T1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  IF EXISTS (SELECT 1 FROM nzi_console.input_spec_categories WHERE category_code = '1.other-stationary-fuels') THEN
    RAISE EXCEPTION '0165: 1.other-stationary-fuels already exists.';
  END IF;
  IF (SELECT count(*) FROM nzi_console.input_spec_fields WHERE category_code = '1.natural-gas' AND active) <> 11 THEN
    RAISE EXCEPTION '0165: 1.natural-gas is not the eleven-field form Other Stationary Fuels copies.';
  END IF;

  INSERT INTO nzi_console.input_spec_categories (category_code, reference_category_key, scope, name, kind, units, manual_entry_hint, created_by, updated_by)
  SELECT '1.other-stationary-fuels', reference_category_key, '1', 'Other Stationary Fuels', 'manual',
         ARRAY['litres','kWh','tonnes','km','mi','m²','units'], manual_entry_hint, 'migration:0165', 'migration:0165'
    FROM nzi_console.input_spec_categories WHERE category_code = '1.natural-gas';

  INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes,
                                             when_lean, label_variants, accepted_units, created_by, updated_by)
  SELECT '1.other-stationary-fuels', field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants,
         CASE WHEN field_key = 'unit' THEN ARRAY['litres','kWh','tonnes'] ELSE accepted_units END,
         'migration:0165', 'migration:0165'
    FROM nzi_console.input_spec_fields WHERE category_code = '1.natural-gas' AND active;

  -- ── T2 + T3: guards first, then the changes ────────────────────────────────────────────────────────────────────────────────
  IF (SELECT array_to_string(units, '|') FROM nzi_console.input_spec_categories WHERE category_code = '3.4') IS DISTINCT FROM 'kWh|litres|tonnes|km|mi|m²|units'
     OR (SELECT array_to_string(units, '|') FROM nzi_console.input_spec_categories WHERE category_code = '3.5') IS DISTINCT FROM 'kWh|litres|tonnes|km|mi|m²|units'
     OR (SELECT array_to_string(units, '|') FROM nzi_console.input_spec_categories WHERE category_code = '3.6') IS DISTINCT FROM 'passenger.km|passenger.mi|kWh|litres|tonnes|km|mi|m²|units'
     OR (SELECT array_to_string(units, '|') FROM nzi_console.input_spec_categories WHERE category_code = '3.7') IS DISTINCT FROM 'passenger.km|passenger.mi|kWh|litres|tonnes|km|mi|m²|units'
     OR (SELECT array_to_string(units, '|') FROM nzi_console.input_spec_categories WHERE category_code = '3.9') IS DISTINCT FROM 'kWh|litres|tonnes|km|mi|m²|units' THEN
    RAISE EXCEPTION '0165: the units of 3.4/3.5/3.6/3.7/3.9 are not what was surveyed; refusing to overwrite a drifted spec.';
  END IF;
  IF (SELECT accepted_units FROM nzi_console.input_spec_fields WHERE category_code = '3.4' AND field_key = 'unit') IS NOT NULL
     OR (SELECT array_to_string(accepted_units, '|') FROM nzi_console.input_spec_fields WHERE category_code = '3.5' AND field_key = 'unit') IS DISTINCT FROM 'tonnes'
     OR (SELECT array_to_string(accepted_units, '|') FROM nzi_console.input_spec_fields WHERE category_code = '3.6' AND field_key = 'unit') IS DISTINCT FROM 'passenger.km|passenger.mi|km|mi'
     OR (SELECT array_to_string(accepted_units, '|') FROM nzi_console.input_spec_fields WHERE category_code = '3.7' AND field_key = 'unit') IS DISTINCT FROM 'passenger.km|passenger.mi|km|mi'
     OR (SELECT accepted_units FROM nzi_console.input_spec_fields WHERE category_code = '3.9' AND field_key = 'unit') IS NOT NULL THEN
    RAISE EXCEPTION '0165: the accepted units of 3.4/3.5/3.6/3.7/3.9 are not what was surveyed; refusing to overwrite a drifted spec.';
  END IF;

  -- T2: GBP on 3.4, 3.5, 3.6, 3.9 — and T3: tonne.km on 3.4, nights on 3.6, per FTE Working Hour on 3.7. Appended; the default stays.
  UPDATE nzi_console.input_spec_categories c
     SET units = c.units || u.added, version = c.version + 1, updated_at = now(), updated_by = 'migration:0165'
    FROM (VALUES ('3.4', ARRAY['GBP','tonne.km']), ('3.5', ARRAY['GBP']), ('3.6', ARRAY['GBP','nights']),
                 ('3.7', ARRAY['per FTE Working Hour']), ('3.9', ARRAY['GBP'])) AS u(code, added)
   WHERE c.category_code = u.code;

  -- Where a category's unit field declares what it accepts, it accepts the additions too (3.4 and 3.9 declare nothing: they
  -- accept any of their units already).
  UPDATE nzi_console.input_spec_fields f
     SET accepted_units = f.accepted_units || u.added, version = f.version + 1, updated_at = now(), updated_by = 'migration:0165'
    FROM (VALUES ('3.5', ARRAY['GBP']), ('3.6', ARRAY['GBP','nights']), ('3.7', ARRAY['per FTE Working Hour'])) AS u(code, added)
   WHERE f.category_code = u.code AND f.field_key = 'unit';

  -- ── Post-condition: the spec now reads exactly as ruled ──────────────────────────────────────────────────────────────────────
  IF (SELECT count(*) FROM nzi_console.input_spec_categories WHERE active) <> 21
     OR (SELECT count(*) FROM nzi_console.input_spec_fields WHERE category_code = '1.other-stationary-fuels' AND active) <> 11
     OR (SELECT array_to_string(accepted_units, '|') FROM nzi_console.input_spec_fields WHERE category_code = '1.other-stationary-fuels' AND field_key = 'unit') IS DISTINCT FROM 'litres|kWh|tonnes'
     OR (SELECT declarative_resolution_enabled OR companions_enabled FROM nzi_console.input_spec_categories WHERE category_code = '1.other-stationary-fuels')
     OR (SELECT array_to_string(units, '|') FROM nzi_console.input_spec_categories WHERE category_code = '3.4') IS DISTINCT FROM 'kWh|litres|tonnes|km|mi|m²|units|GBP|tonne.km'
     OR (SELECT array_to_string(accepted_units, '|') FROM nzi_console.input_spec_fields WHERE category_code = '3.6' AND field_key = 'unit') IS DISTINCT FROM 'passenger.km|passenger.mi|km|mi|GBP|nights'
     OR (SELECT array_to_string(accepted_units, '|') FROM nzi_console.input_spec_fields WHERE category_code = '3.7' AND field_key = 'unit') IS DISTINCT FROM 'passenger.km|passenger.mi|km|mi|per FTE Working Hour' THEN
    RAISE EXCEPTION '0165: the spec does not read as ruled after the change.';
  END IF;
END $$;

COMMIT;
