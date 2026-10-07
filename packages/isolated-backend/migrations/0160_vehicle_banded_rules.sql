-- 0160 Company vehicles: a looked-up car or van is priced per mile at its v7 size band, and the per-litre diesel
-- default is retired from the registration flow (JW-11 steps 3(a) + 4, ruled 6 Oct 2026).
--
-- ## Why
--
-- Since 0113 the only company-vehicles rule has been `dvla-diesel`: any vehicle the DVLA reports as diesel was priced
-- with "Diesel (average biofuel blend)", **per litre** (0130 re-pointed it to `uk-ghg-1_101_1011_8_1`). Every petrol,
-- hybrid or gas car fell through to a manual pick, and a diesel car was priced as if its fuel, not its distance, had
-- been recorded. v7 instead bands the vehicle — a car by engine size, a van by weight — and prices it **per mile**
-- from the "Cars (by size)" / "Vans" rows, falling back to the "Average" row when the band's is missing.
--
-- The code half is the previous PR: `classifyVehicle` gives every looked-up car or van a `category`
-- (`car|small|petrol`, `van|class-ii|diesel`) and a `fallback` (`car|average|petrol`), both asserted at capture and
-- handed to the resolver as DVLA attributes. This migration is the data half — **ruled approach (a): data-seed rules**,
-- one `enriched` rule per category pointing at the real per-mile factor, with fallback rules after them. It reuses the
-- enriched-rule mechanism as it stands (0113), so there is no new rule kind and no resolver change.
--
-- ## The rules
--
-- - **Category rules (ordering 10–39)** match `category` and name the band's own per-mile factor. Only the measured
--   bands are seeded — small/medium/large cars, Class I/II/III vans — in each fuel the library publishes for that band.
-- - **Fallback rules (ordering 60–79)** match `fallback` and name the "Average" band's per-mile factor for the same
--   fuel. They answer an unmeasured vehicle (whose category is already the Average band) and, as in v7, a measured one
--   whose band has no factor for its fuel — a small LPG car, which the library does not publish, is priced as an
--   average LPG car. The resolver tries rules in order and falls through when a factor is not in the job's datasets
--   (0113's additive rule), which is exactly v7's two-step lookup.
-- - **Every id was verified against the loaded library** (staging, `net-zero-international`, read-only, 7 Oct): each is
--   active, unit `miles`, Scope 1, and carried by all eight editions 2019–2026 — the id is stable across years, and the
--   value comes from whichever edition the job selects. The levels each names are in the note on its row.
--
-- **Not seeded, deliberately:**
-- - **Plug-in hybrids:** the DVLA reports a plug-in hybrid and a hybrid alike as "HYBRID ELECTRIC", so v7's "Hybrid"
--   row is the one it can name; the PHEV rows would need a fact the lookup does not return.
-- - **Battery-electric vehicles:** v7 prices them under "UK electricity for EVs", which is Scope 2 — not this Scope 1
--   category. An EV stays a person's pick, as today.
-- - **HGVs and motorbikes:** banded in v7, but outside the ruled scope (cars and vans). `classifyVehicle` gives them no
--   category, so they stay a person's pick; adding them is a further rule set over the same mechanism.
-- - **Kilometres:** each band is seeded once, per mile — the uniqueness index allows one rule per value. An entry made
--   in km is reconciled against the factor's unit as any other entry is (D2).
--
-- ## Step 4: the per-litre `dvla-diesel` rule is retired from the registration flow (ruled)
--
-- Deactivated, not deleted: rows already priced by it keep their provenance. A diesel car or van now takes its banded
-- per-mile factor like any other fuel. **Per-litre fuel-volume entry stays a Fuels method** (ruled), separate from the
-- registration flow; nothing here touches it. With the lookup consulted, the coarser rules are set aside (NZC-151), so
-- a registration entry measured in litres goes to a person rather than to a per-litre guess.
--
-- ## Refuses unless the ground is what was characterised
--
-- `dvla-diesel` must be active and name the factor 0130 left it on; afterwards it must be inactive, and exactly the
-- seeded set of `dvla` rules must be active in the category, none of them naming a per-litre factor id.

BEGIN;

DO $$
DECLARE found text;
BEGIN
  SELECT factor_base INTO found FROM nzi_console.input_spec_factor_rules
   WHERE category_code = '1.company-vehicles' AND rule_key = 'dvla-diesel' AND active;
  IF found IS DISTINCT FROM 'uk-ghg-1_101_1011_8_1' THEN
    RAISE EXCEPTION '0160: 1.company-vehicles/dvla-diesel was expected active on uk-ghg-1_101_1011_8_1 and is %.', coalesce(found, 'missing or inactive');
  END IF;
  IF EXISTS (SELECT 1 FROM nzi_console.input_spec_factor_rules
              WHERE category_code = '1.company-vehicles' AND enrichment_source = 'dvla' AND basis_field_key IN ('category', 'fallback')) THEN
    RAISE EXCEPTION '0160: a banded dvla rule already exists in 1.company-vehicles.';
  END IF;
END $$;

UPDATE nzi_console.input_spec_factor_rules
   SET active = false, version = version + 1, updated_at = now(), updated_by = 'migration:0160',
       note = note || ' Retired by 0160 (JW-11): the registration flow prices a car or van per mile at its size band; per-litre entry stays a Fuels method.'
 WHERE category_code = '1.company-vehicles' AND rule_key = 'dvla-diesel';

INSERT INTO nzi_console.input_spec_factor_rules
  (category_code, rule_key, ordering, rule_kind, factor_base,
   enrichment_source, enrichment_key_field, basis_field_key, basis_value,
   note, created_by, updated_by)
SELECT '1.company-vehicles', rule_key, ordering, 'enriched', factor_base,
       'dvla', 'registrationFinder', basis_field_key, basis_value,
       note, 'migration:0160', 'migration:0160'
  FROM (VALUES
    -- Cars by engine size (petrol and other non-diesel: small <= 1400 cc, medium <= 2000; diesel: small <= 1700, medium <= 2000)
    ('dvla-car-small-petrol',     10, 'uk-ghg-4_301_3046_9_1', 'category', 'car|small|petrol',     'Passenger vehicles › Cars (by size) › Small car › Petrol, per mile'),
    ('dvla-car-small-diesel',     11, 'uk-ghg-4_301_3045_9_1', 'category', 'car|small|diesel',     'Passenger vehicles › Cars (by size) › Small car › Diesel, per mile'),
    ('dvla-car-small-hybrid',     12, 'uk-ghg-4_301_3047_9_1', 'category', 'car|small|hybrid',     'Passenger vehicles › Cars (by size) › Small car › Hybrid, per mile'),
    ('dvla-car-small-unknown',    13, 'uk-ghg-4_301_3050_9_1', 'category', 'car|small|unknown',    'Passenger vehicles › Cars (by size) › Small car › Unknown, per mile'),
    ('dvla-car-medium-petrol',    14, 'uk-ghg-4_301_3054_9_1', 'category', 'car|medium|petrol',    'Passenger vehicles › Cars (by size) › Medium car › Petrol, per mile'),
    ('dvla-car-medium-diesel',    15, 'uk-ghg-4_301_3053_9_1', 'category', 'car|medium|diesel',    'Passenger vehicles › Cars (by size) › Medium car › Diesel, per mile'),
    ('dvla-car-medium-hybrid',    16, 'uk-ghg-4_301_3055_9_1', 'category', 'car|medium|hybrid',    'Passenger vehicles › Cars (by size) › Medium car › Hybrid, per mile'),
    ('dvla-car-medium-lpg',       17, 'uk-ghg-4_301_3057_9_1', 'category', 'car|medium|lpg',       'Passenger vehicles › Cars (by size) › Medium car › LPG, per mile'),
    ('dvla-car-medium-cng',       18, 'uk-ghg-4_301_3056_9_1', 'category', 'car|medium|cng',       'Passenger vehicles › Cars (by size) › Medium car › CNG, per mile'),
    ('dvla-car-medium-unknown',   19, 'uk-ghg-4_301_3058_9_1', 'category', 'car|medium|unknown',   'Passenger vehicles › Cars (by size) › Medium car › Unknown, per mile'),
    ('dvla-car-large-petrol',     20, 'uk-ghg-4_301_3062_9_1', 'category', 'car|large|petrol',     'Passenger vehicles › Cars (by size) › Large car › Petrol, per mile'),
    ('dvla-car-large-diesel',     21, 'uk-ghg-4_301_3061_9_1', 'category', 'car|large|diesel',     'Passenger vehicles › Cars (by size) › Large car › Diesel, per mile'),
    ('dvla-car-large-hybrid',     22, 'uk-ghg-4_301_3063_9_1', 'category', 'car|large|hybrid',     'Passenger vehicles › Cars (by size) › Large car › Hybrid, per mile'),
    ('dvla-car-large-lpg',        23, 'uk-ghg-4_301_3065_9_1', 'category', 'car|large|lpg',        'Passenger vehicles › Cars (by size) › Large car › LPG, per mile'),
    ('dvla-car-large-cng',        24, 'uk-ghg-4_301_3064_9_1', 'category', 'car|large|cng',        'Passenger vehicles › Cars (by size) › Large car › CNG, per mile'),
    ('dvla-car-large-unknown',    25, 'uk-ghg-4_301_3066_9_1', 'category', 'car|large|unknown',    'Passenger vehicles › Cars (by size) › Large car › Unknown, per mile'),
    -- Vans by revenue weight (Class I <= 1305 kg, Class II <= 1740, Class III <= 3500)
    ('dvla-van-class-i-diesel',   30, 'uk-ghg-5_303_3081_9_1', 'category', 'van|class-i|diesel',   'Delivery vehicles › Vans › Class I (up to 1.305 tonnes) › Diesel, per mile'),
    ('dvla-van-class-i-petrol',   31, 'uk-ghg-5_303_3082_9_1', 'category', 'van|class-i|petrol',   'Delivery vehicles › Vans › Class I (up to 1.305 tonnes) › Petrol, per mile'),
    ('dvla-van-class-ii-diesel',  32, 'uk-ghg-5_303_3088_9_1', 'category', 'van|class-ii|diesel',  'Delivery vehicles › Vans › Class II (1.305 to 1.74 tonnes) › Diesel, per mile'),
    ('dvla-van-class-ii-petrol',  33, 'uk-ghg-5_303_3089_9_1', 'category', 'van|class-ii|petrol',  'Delivery vehicles › Vans › Class II (1.305 to 1.74 tonnes) › Petrol, per mile'),
    ('dvla-van-class-iii-diesel', 34, 'uk-ghg-5_303_3095_9_1', 'category', 'van|class-iii|diesel', 'Delivery vehicles › Vans › Class III (1.74 to 3.5 tonnes) › Diesel, per mile'),
    ('dvla-van-class-iii-petrol', 35, 'uk-ghg-5_303_3096_9_1', 'category', 'van|class-iii|petrol', 'Delivery vehicles › Vans › Class III (1.74 to 3.5 tonnes) › Petrol, per mile'),
    -- v7's fallback: the Average band, same fuel — an unmeasured vehicle, or a band the library has no factor for
    ('dvla-car-average-petrol',   60, 'uk-ghg-4_301_3070_9_1', 'fallback', 'car|average|petrol',   'Passenger vehicles › Cars (by size) › Average car › Petrol, per mile'),
    ('dvla-car-average-diesel',   61, 'uk-ghg-4_301_3069_9_1', 'fallback', 'car|average|diesel',   'Passenger vehicles › Cars (by size) › Average car › Diesel, per mile'),
    ('dvla-car-average-hybrid',   62, 'uk-ghg-4_301_3071_9_1', 'fallback', 'car|average|hybrid',   'Passenger vehicles › Cars (by size) › Average car › Hybrid, per mile'),
    ('dvla-car-average-lpg',      63, 'uk-ghg-4_301_3073_9_1', 'fallback', 'car|average|lpg',      'Passenger vehicles › Cars (by size) › Average car › LPG, per mile'),
    ('dvla-car-average-cng',      64, 'uk-ghg-4_301_3072_9_1', 'fallback', 'car|average|cng',      'Passenger vehicles › Cars (by size) › Average car › CNG, per mile'),
    ('dvla-car-average-unknown',  65, 'uk-ghg-4_301_3074_9_1', 'fallback', 'car|average|unknown',  'Passenger vehicles › Cars (by size) › Average car › Unknown, per mile'),
    ('dvla-van-average-diesel',   70, 'uk-ghg-5_303_3102_9_1', 'fallback', 'van|average|diesel',   'Delivery vehicles › Vans › Average (up to 3.5 tonnes) › Diesel, per mile'),
    ('dvla-van-average-petrol',   71, 'uk-ghg-5_303_3103_9_1', 'fallback', 'van|average|petrol',   'Delivery vehicles › Vans › Average (up to 3.5 tonnes) › Petrol, per mile'),
    ('dvla-van-average-lpg',      72, 'uk-ghg-5_303_3105_9_1', 'fallback', 'van|average|lpg',      'Delivery vehicles › Vans › Average (up to 3.5 tonnes) › LPG, per mile'),
    ('dvla-van-average-cng',      73, 'uk-ghg-5_303_3104_9_1', 'fallback', 'van|average|cng',      'Delivery vehicles › Vans › Average (up to 3.5 tonnes) › CNG, per mile'),
    ('dvla-van-average-unknown',  74, 'uk-ghg-5_303_3106_9_1', 'fallback', 'van|average|unknown',  'Delivery vehicles › Vans › Average (up to 3.5 tonnes) › Unknown, per mile')
  ) AS r(rule_key, ordering, factor_base, basis_field_key, basis_value, note);

DO $$
DECLARE seeded integer; litre_rules text;
BEGIN
  IF EXISTS (SELECT 1 FROM nzi_console.input_spec_factor_rules
              WHERE category_code = '1.company-vehicles' AND rule_key = 'dvla-diesel' AND active) THEN
    RAISE EXCEPTION '0160: dvla-diesel is still active.';
  END IF;
  SELECT count(*) INTO seeded FROM nzi_console.input_spec_factor_rules
   WHERE category_code = '1.company-vehicles' AND enrichment_source = 'dvla' AND active;
  IF seeded <> 33 THEN
    RAISE EXCEPTION '0160 expected exactly 33 active dvla rules in 1.company-vehicles, found %.', seeded;
  END IF;
  SELECT string_agg(rule_key, ', ') INTO litre_rules FROM nzi_console.input_spec_factor_rules
   WHERE category_code = '1.company-vehicles' AND active AND factor_base NOT LIKE '%\_9\_1' ESCAPE '\';
  IF litre_rules IS NOT NULL THEN
    RAISE EXCEPTION '0160: an active company-vehicles rule names a factor that is not per mile: %.', litre_rules;
  END IF;
END $$;

COMMIT;
