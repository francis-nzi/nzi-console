-- 0130 The enabled factor rules name the real, imported factors — and the synthetic set is retired (ruled 26 Sep 2026).
--
-- ## Why
--
-- The three enabled categories (0121, 0123) resolve through rules written before any real reference data existed, so
-- they name demonstration factors: `electricity-demo`, `diesel-demo`, and the T&D companion `electricity-td-demo`. The
-- v7 import (0126–0128, #317/#319) loaded the real library into `net-zero-international`, and the console moves there
-- as its capture home. A rule names a factor id, and the resolver looks it up in the job's selected datasets — so until
-- the rules name the real ids, an entry on real data resolves to nothing and falls to a person's pick.
--
-- ## What changes — the mapping ruled at Stop 1, verified against the loaded data
--
-- | Category · rule                                  | Was                   | Now                        | Real factor                                      |
-- |--------------------------------------------------|-----------------------|----------------------------|--------------------------------------------------|
-- | 2.purchased-electricity · grid-electricity       | electricity-demo      | uk-ghg-7_400_4000_5_1      | UK electricity – generated, kWh, Scope 2         |
-- | 2.renewable-electricity · grid-electricity       | electricity-demo      | uk-ghg-7_400_4000_5_1      | the same                                         |
-- | 1.company-vehicles · dvla-diesel                 | diesel-demo           | uk-ghg-1_101_1011_8_1      | Diesel (average biofuel blend), litres, Scope 1  |
-- | 2.purchased-electricity · grid-td (companion)    | electricity-td-demo   | uk-ghg-13_402_4000_5_1     | T&D – UK electricity, kWh, Scope 3               |
-- | 2.renewable-electricity · grid-td (companion)    | electricity-td-demo   | uk-ghg-13_402_4000_5_1     | the same                                         |
--
-- Diesel is the **base**, not `-vcd`: v7's `-vcd`/`-vvd`/`-vh` carry the base's value in every year, and the DVLA rule
-- branches on fuel only, so naming `-vcd` would file every diesel van and HGV as a car. Car/van/HGV branching is its
-- own policy, not this re-point. The value comes from whichever year's dataset a job selects; the rule names only the
-- id. `fuel-litres` (inactive since 0119) is left as it is. The companions stay dormant: `companions_enabled` is off
-- everywhere, and nothing here turns it on.
--
-- ## The synthetic set is retired, not deleted
--
-- Every dataset marked `synthetic` becomes `superseded` — out of automatic selection, still readable — and its factors
-- inactive. Nothing is deleted: rows already priced against a demonstration factor keep their provenance.
--
-- ## Refuses unless the ground is what was characterised
--
-- Each re-pointed rule must exist, and name the demonstration factor it is replacing; afterwards no active rule or
-- companion names a `-demo` id, and exactly the three primaries are enabled with every companion off.

BEGIN;

DO $$
DECLARE
  expected record;
  found text;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('rule', '2.purchased-electricity', 'grid-electricity', 'electricity-demo'),
      ('rule', '2.renewable-electricity', 'grid-electricity', 'electricity-demo'),
      ('rule', '1.company-vehicles', 'dvla-diesel', 'diesel-demo'),
      ('companion', '2.purchased-electricity', 'grid-td', 'electricity-td-demo'),
      ('companion', '2.renewable-electricity', 'grid-td', 'electricity-td-demo')
    ) AS t(kind, category_code, rule_key, factor_base)
  LOOP
    IF expected.kind = 'rule' THEN
      SELECT factor_base INTO found FROM nzi_console.input_spec_factor_rules
       WHERE category_code = expected.category_code AND rule_key = expected.rule_key AND active;
    ELSE
      SELECT factor_base INTO found FROM nzi_console.input_spec_companion_rules
       WHERE category_code = expected.category_code AND companion_key = expected.rule_key AND active;
    END IF;
    IF found IS DISTINCT FROM expected.factor_base THEN
      RAISE EXCEPTION '0130: % %/% was expected to name % and names %.',
        expected.kind, expected.category_code, expected.rule_key, expected.factor_base, coalesce(found, 'nothing (missing or inactive)');
    END IF;
  END LOOP;
END $$;

UPDATE nzi_console.input_spec_factor_rules
   SET factor_base = CASE category_code WHEN '1.company-vehicles' THEN 'uk-ghg-1_101_1011_8_1' ELSE 'uk-ghg-7_400_4000_5_1' END,
       version = version + 1, updated_at = now(), updated_by = 'migration:0130'
 WHERE (category_code, rule_key) IN (('2.purchased-electricity', 'grid-electricity'),
                                     ('2.renewable-electricity', 'grid-electricity'),
                                     ('1.company-vehicles', 'dvla-diesel'));

UPDATE nzi_console.input_spec_companion_rules
   SET factor_base = 'uk-ghg-13_402_4000_5_1', version = version + 1, updated_at = now(), updated_by = 'migration:0130'
 WHERE (category_code, companion_key) IN (('2.purchased-electricity', 'grid-td'), ('2.renewable-electricity', 'grid-td'));

-- The synthetic set, organisation by organisation: row-level security is forced on both tables, so each is updated as
-- its own tenant.
DO $$
DECLARE org text;
BEGIN
  FOR org IN SELECT organisation_id FROM nzi_console.organisations LOOP
    PERFORM set_config('app.organisation_id', org, true);
    UPDATE nzi_console.emission_factors f
       SET active = false
      FROM nzi_console.emission_factor_datasets d
     WHERE (d.organisation_id, d.dataset_id) = (f.organisation_id, f.dataset_id) AND d.synthetic AND f.active;
    UPDATE nzi_console.emission_factor_datasets SET status = 'superseded' WHERE synthetic AND status <> 'superseded';
  END LOOP;
  PERFORM set_config('app.organisation_id', '', true);
END $$;

DO $$
DECLARE left_over text; enabled_now text;
BEGIN
  SELECT string_agg(category_code || '/' || rule_key || ' → ' || factor_base, ', ') INTO left_over FROM (
    SELECT category_code, rule_key, factor_base FROM nzi_console.input_spec_factor_rules WHERE active AND factor_base LIKE '%-demo%'
    UNION ALL
    SELECT category_code, companion_key, factor_base FROM nzi_console.input_spec_companion_rules WHERE active AND factor_base LIKE '%-demo%'
  ) demo;
  IF left_over IS NOT NULL THEN
    RAISE EXCEPTION '0130: an active rule still names a demonstration factor: %.', left_over;
  END IF;
  SELECT string_agg(category_code, ', ' ORDER BY category_code) INTO enabled_now
    FROM nzi_console.input_spec_categories WHERE declarative_resolution_enabled OR companions_enabled;
  IF enabled_now IS DISTINCT FROM '1.company-vehicles, 2.purchased-electricity, 2.renewable-electricity'
     OR EXISTS (SELECT 1 FROM nzi_console.input_spec_categories WHERE companions_enabled) THEN
    RAISE EXCEPTION '0130 expected exactly the three primaries enabled, companions off; found: %.', coalesce(enabled_now, 'none');
  END IF;
END $$;

COMMIT;
