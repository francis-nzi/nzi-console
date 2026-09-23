-- 0111 A quantity field declares the units it accepts (NZC-146).
--
-- ## The problem this fixes, visible in 0093's own data
--
-- `input_spec_categories.units` is one list per category, and every one of the twenty categories 0093
-- seeded carries the **same** list: `kWh, litres, tonnes, km, mi, m², units`. So Refrigerants offers
-- kilowatt-hours and kilometres, Purchased Electricity offers litres and square metres, and Waste offers
-- miles. The list is global wearing a per-category coat.
--
-- Units are a property of the field, not of the category: a category can collect a distance *and* a
-- volume, and the same category's spend variant collects neither. So the declaration moves to the field.
--
-- ## Additive, and null means what it used to
--
-- `accepted_units` is nullable. Null is "this field does not constrain units", which is exactly today's
-- behaviour, so every existing spec keeps working and categories tighten one at a time. A field that
-- declares units is checked against them; a field that declares none is not.
--
-- ## What is seeded here, and what is deliberately left alone
--
-- Only **narrowings of each category's existing list**. Where the right unit is genuinely absent from
-- that list — kilograms for a refrigerant charge, tonne-kilometres for freight — the field is left null
-- rather than having a new unit invented for it in a migration. Adding a unit to a category is a domain
-- decision about what that category collects, and it belongs with the per-category spec work and the
-- workflow diagrams, not here. The mechanism ships now; the domain narrowing follows per category.

BEGIN;

ALTER TABLE nzi_console.input_spec_fields
  ADD COLUMN accepted_units text[]
    CONSTRAINT input_spec_field_accepted_units_not_empty
      CHECK (accepted_units IS NULL OR cardinality(accepted_units) > 0);

COMMENT ON COLUMN nzi_console.input_spec_fields.accepted_units IS
  'The units this field accepts. Null means the field does not constrain units, which is the behaviour every spec had before this column existed — so declaring them is additive and per-category. An entered unit outside this list is refused at the commit, and separately from whether it reconciles with the resolved factor''s own unit: "this category does not collect litres" and "this factor is not priced in litres" are different problems with different fixes.';

-- ── The narrowings that follow from what each category already offers ────────────────
--
-- Gas and electricity are metered in energy; a vehicle is a volume or a distance; waste is a mass;
-- travel and commuting are passenger-distance or distance. Each of these is a subset of the list the
-- category already had.
UPDATE nzi_console.input_spec_fields SET accepted_units = ARRAY['kWh'], updated_by = 'migration:0111', updated_at = now()
 WHERE field_key = 'unit' AND category_code IN ('1.natural-gas', '2.purchased-electricity', '2.renewable-electricity');

UPDATE nzi_console.input_spec_fields SET accepted_units = ARRAY['litres', 'km', 'mi'], updated_by = 'migration:0111', updated_at = now()
 WHERE field_key = 'unit' AND category_code = '1.company-vehicles';

UPDATE nzi_console.input_spec_fields SET accepted_units = ARRAY['tonnes'], updated_by = 'migration:0111', updated_at = now()
 WHERE field_key = 'unit' AND category_code = '3.5';

UPDATE nzi_console.input_spec_fields SET accepted_units = ARRAY['passenger.km', 'passenger.mi', 'km', 'mi'], updated_by = 'migration:0111', updated_at = now()
 WHERE field_key = 'unit' AND category_code IN ('3.6', '3.7');

-- Left null on purpose, each for a stated reason:
--
--   * `1.refrigerants` — a charge is measured in kilograms, and `kg` is not in the category's list. The
--     nearest available unit is `tonnes`, which would have every entry a thousand times too large if
--     anybody typed the number they read off the cylinder.
--   * `3.4` / `3.9` transport — freight is tonne-kilometres, which no category offers yet.
--   * everything else — the category's own units are the global list, so narrowing them is a decision
--     about what that category collects rather than a correction of this one.

COMMIT;
