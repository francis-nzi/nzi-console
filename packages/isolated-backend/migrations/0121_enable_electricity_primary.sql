-- 0121 Electricity's primary factor is resolved declaratively; its companion stays held (Stop 2, slice 2b).
--
-- ## What switches on
--
-- `2.purchased-electricity` and `2.renewable-electricity`: the write path now resolves their primary factor from
-- the declared rule (0112, 0117) and applies F1 — a missing factor is filled, the declared one accepted, a
-- different one refused unless it is a deliberate choice with a reason, and never one the row may not carry.
--
-- Chosen first because the characterisation (NZC-160) predicts it divergence-free: every electricity entry
-- already resolves to the grid factor a person would pick, under every supply source. Sized on staging before
-- enabling: one purchased-electricity row carries a different factor, and meets F1 on its next edit — to be
-- corrected, or kept as a deliberate choice with a reason. Both renewable rows already carry the declared factor.
-- Three rows is a pre-real-data figure, not a forecast; the sizing is re-run before enablement meets migrated
-- client data.
--
-- ## What stays off
--
-- `companions_enabled`. The transmission-and-distribution row waits on how it coexists with T&D captured by hand
-- in 3.3 (NZC-160 H4). So an electricity entry produces its location-based headline row and nothing beside it.
--
-- ## The grid factor is the rule's to name
--
-- Nothing here, and nothing in the write path, names a factor. The categories resolve through their declared
-- rules against whichever datasets a job selected, so a regional or period grid is a rule and a dataset — not a
-- change to this switch or to the code behind it.
--
-- ## Refuses unless the ground is what was sized
--
-- Each category must exist, be active, carry an active declared primary rule, and have its companion off. After
-- the update exactly these two are enabled, both companions off. Anything else stops the deploy with a message:
-- a switch that turned on something unsized, or on a category with nothing to resolve, would report success and
-- change what capture does without anyone having looked.

BEGIN;

DO $$
DECLARE
  category text;
  rules integer;
  enabled_now text;
BEGIN
  FOREACH category IN ARRAY ARRAY['2.purchased-electricity', '2.renewable-electricity'] LOOP
    IF NOT EXISTS (SELECT 1 FROM nzi_console.input_spec_categories WHERE category_code = category AND active) THEN
      RAISE EXCEPTION '0121: % is not an active category.', category;
    END IF;
    SELECT count(*) INTO rules FROM nzi_console.input_spec_factor_rules WHERE category_code = category AND active;
    IF rules = 0 THEN
      RAISE EXCEPTION '0121: % declares no active factor rule, so switching it on would resolve nothing.', category;
    END IF;
  END LOOP;

  UPDATE nzi_console.input_spec_categories
     SET declarative_resolution_enabled = true,
         version = version + 1,
         updated_at = now(),
         updated_by = 'migration:0121'
   WHERE category_code IN ('2.purchased-electricity', '2.renewable-electricity');

  SELECT string_agg(category_code, ', ' ORDER BY category_code) INTO enabled_now
    FROM nzi_console.input_spec_categories WHERE declarative_resolution_enabled OR companions_enabled;
  IF enabled_now IS DISTINCT FROM '2.purchased-electricity, 2.renewable-electricity'
     OR EXISTS (SELECT 1 FROM nzi_console.input_spec_categories WHERE companions_enabled) THEN
    RAISE EXCEPTION '0121 expected exactly the two electricity primaries enabled, companions off; found: %.', coalesce(enabled_now, 'none');
  END IF;
END $$;

COMMIT;
