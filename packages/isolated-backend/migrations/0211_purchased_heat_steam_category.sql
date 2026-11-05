-- 0211 A Scope 2 category for purchased heat and steam (NZC-046 taxonomy; NZC-171 membership; BRIEF-purchased-heat-steam-category).
--
-- ## Why
--
-- Scope 2 is purchased electricity, steam, heat and cooling, but the taxonomy named only electricity. DESNZ "Heat and steam" (District
-- heat and steam, Onsite heat and steam) was therefore held back by 0210: known and listed on the admin Datasets screen, offered in
-- no category, so a client buying district heat or steam could pick no DESNZ factor.
--
-- ## What this does
--
-- 1. `2.purchased-heat-steam` ("Purchased Heat & Steam", Scope 2, kind `manual`), after Renewable Electricity. Its form is Purchased
--    Electricity's, field for field, copied from the rows as they stand - except `supplySource`: that field asks how *electricity*
--    reached the site (grid, or generated on site) and decides whether a transmission-and-distribution companion row exists
--    (NZC-154). Heat has no such companion rule, so the question would have no consequence and no honest answer. It resolves the way
--    Natural Gas does: free search, no declared rules, no companions.
-- 2. The held-back rule (`Heat and steam` -> no category) is retired, never re-pointed (0210's trigger forbids it), and a new rule
--    files the family under the new category. WTT- heat and steam stays at 3.3: it is well-to-tank of energy, not the purchase.
--
-- "Heat energy" is not a level 1 in the loaded library (the only heat paths are Heat and steam, WTT- heat and steam, Homeworking,
-- and the T&D heat distribution row), so it carries no rule.
--
-- ## Guards - refuses unless the ground is exactly as surveyed
--
-- Refuses if the category already exists, if Purchased Electricity is not the twelve-field form it is copied from, or if the
-- held-back rule is not exactly one active, uncategorised `Heat and steam` rule. No factor, value, row or report changes.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM nzi_console.input_spec_categories WHERE category_code = '2.purchased-heat-steam') THEN
    RAISE EXCEPTION '0211: 2.purchased-heat-steam already exists.';
  END IF;
  IF (SELECT count(*) FROM nzi_console.input_spec_fields WHERE category_code = '2.purchased-electricity' AND active) <> 12 THEN
    RAISE EXCEPTION '0211: 2.purchased-electricity is not the twelve-field form Purchased Heat & Steam copies.';
  END IF;
  IF (SELECT count(*) FROM nzi_console.factor_category_membership
       WHERE lower(btrim(source_l1)) = 'heat and steam' AND source_l2 IS NULL AND source_l3 IS NULL AND category_code IS NULL AND status = 'active') <> 1 THEN
    RAISE EXCEPTION '0211: expected exactly one active held-back "Heat and steam" rule.';
  END IF;

  -- ── The category and its form ───────────────────────────────────────────────────────────────────────────────────
  INSERT INTO nzi_console.input_spec_categories (category_code, reference_category_key, scope, name, kind, units, manual_entry_hint, created_by, updated_by)
  SELECT '2.purchased-heat-steam', reference_category_key, '2', 'Purchased Heat & Steam', 'manual',
         ARRAY['kWh','tonnes','km','mi','m²','units'], manual_entry_hint, 'migration:0211', 'migration:0211'
    FROM nzi_console.input_spec_categories WHERE category_code = '2.purchased-electricity';

  INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes,
                                             when_lean, label_variants, accepted_units, created_by, updated_by)
  SELECT '2.purchased-heat-steam', field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants,
         accepted_units, 'migration:0211', 'migration:0211'
    FROM nzi_console.input_spec_fields
   WHERE category_code = '2.purchased-electricity' AND active AND field_key <> 'supplySource';

  -- ── The family: retire the held-back rule, file the family ──────────────────────────────────────────────────────
  UPDATE nzi_console.factor_category_membership
     SET status = 'retired', retired_at = now(), retired_by = 'migration:0211', version = version + 1, updated_at = now(), updated_by = 'migration:0211'
   WHERE lower(btrim(source_l1)) = 'heat and steam' AND source_l2 IS NULL AND source_l3 IS NULL AND category_code IS NULL AND status = 'active';

  INSERT INTO nzi_console.factor_category_membership (source_l1, source_l2, source_l3, category_code, note, created_by, updated_by)
  VALUES ('Heat and steam', NULL, NULL, '2.purchased-heat-steam', 'Purchased heat and steam is Scope 2 (0211: the held-back family, now filed).', 'migration:0211', 'migration:0211');

  INSERT INTO nzi_console.audit_events
    (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, after_json)
  SELECT o.organisation_id, gen_random_uuid()::text, 'migration:0211', 'system', 'factor.membership.filed', 'factor_category_membership', '0211', 'migration:0211',
         'Purchased Heat & Steam (2.purchased-heat-steam) added; the held-back "Heat and steam" family retired from held-back and filed under it.',
         jsonb_build_object('categoryCode', '2.purchased-heat-steam', 'family', 'Heat and steam',
                            'heldBack', (SELECT count(*) FROM nzi_console.factor_category_membership WHERE category_code IS NULL AND status = 'active'))
    FROM nzi_console.organisations o;

  -- ── Post-condition ──────────────────────────────────────────────────────────────────────────────────────────────
  IF (SELECT count(*) FROM nzi_console.input_spec_categories WHERE active) <> 22
     OR (SELECT count(*) FROM nzi_console.input_spec_fields WHERE category_code = '2.purchased-heat-steam' AND active) <> 11
     OR EXISTS (SELECT 1 FROM nzi_console.input_spec_fields WHERE category_code = '2.purchased-heat-steam' AND field_key = 'supplySource')
     OR (SELECT declarative_resolution_enabled OR companions_enabled FROM nzi_console.input_spec_categories WHERE category_code = '2.purchased-heat-steam')
     OR EXISTS (SELECT 1 FROM nzi_console.factor_category_membership WHERE category_code IS NULL AND status = 'active')
     OR (SELECT count(*) FROM nzi_console.factor_category_membership WHERE category_code = '2.purchased-heat-steam' AND status = 'active') <> 1 THEN
    RAISE EXCEPTION '0211: the spec and the map do not read as ruled after the change.';
  END IF;
END $$;

COMMIT;
