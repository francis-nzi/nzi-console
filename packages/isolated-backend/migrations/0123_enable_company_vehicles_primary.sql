-- 0123 Company vehicles resolve their primary factor declaratively (Stop 2, slice 2c).
--
-- ## What switches on
--
-- `1.company-vehicles`: the write path resolves its factor from the declared rules and applies F1. Since 0119 the
-- only active rule is `dvla-diesel` — a vehicle the DVLA lookup names as diesel is priced with the diesel factor,
-- the lookup's attributes carried to the write (F3) and its unit checked (D2). Everything else — a petrol or hybrid
-- plate, a vehicle recorded in kilometres, an entry with no plate — declines to a person's pick, and the vehicle
-- lookup no longer suggests the label ILIKE's Scope 1 guess for this category (H6).
--
-- Business travel and commuting are **not** switched on. They reuse this flow, but they accept distances only and
-- the flow's one factor is priced per litre, so they cannot resolve until per-distance factors exist. What they get
-- now is the rule that runs for every variant category, switch or no switch: the base of their own variant is
-- refused, in the write and in the pick list.
--
-- ## Sized before enabling
--
-- An existing company-vehicle row meets F1 on its next edit. With no lookup attributes carried on an edit, nothing
-- resolves, so what is refused is only a factor the row may not carry at all — one not in a selected dataset, not a
-- Scope 1 factor, or a companion. Counted on staging before this merges; re-counted before migrated client data.
--
-- ## Refuses unless the ground is as sized
--
-- The category must be active with an active declared rule, and afterwards exactly the three primaries are on —
-- electricity's two (0121) and this — with every companion off.

BEGIN;

DO $$
DECLARE enabled_now text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM nzi_console.input_spec_categories WHERE category_code = '1.company-vehicles' AND active) THEN
    RAISE EXCEPTION '0123: 1.company-vehicles is not an active category.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM nzi_console.input_spec_factor_rules WHERE category_code = '1.company-vehicles' AND active) THEN
    RAISE EXCEPTION '0123: 1.company-vehicles declares no active factor rule, so switching it on would resolve nothing.';
  END IF;

  UPDATE nzi_console.input_spec_categories
     SET declarative_resolution_enabled = true, version = version + 1, updated_at = now(), updated_by = 'migration:0123'
   WHERE category_code = '1.company-vehicles';

  SELECT string_agg(category_code, ', ' ORDER BY category_code) INTO enabled_now
    FROM nzi_console.input_spec_categories WHERE declarative_resolution_enabled OR companions_enabled;
  IF enabled_now IS DISTINCT FROM '1.company-vehicles, 2.purchased-electricity, 2.renewable-electricity'
     OR EXISTS (SELECT 1 FROM nzi_console.input_spec_categories WHERE companions_enabled) THEN
    RAISE EXCEPTION '0123 expected exactly company vehicles and the two electricity primaries enabled, companions off; found: %.', coalesce(enabled_now, 'none');
  END IF;
END $$;

COMMIT;
