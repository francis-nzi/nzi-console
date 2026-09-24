-- 0119 A unit alone does not identify a fuel: `fuel-litres` is deactivated (NZC-160 D3).
--
-- ## What it did
--
-- 0112 seeded `1.company-vehicles / fuel-litres`: a basis-branch saying that a vehicle entry recorded in
-- litres is priced with `diesel-demo`. The wiring characterisation (NZC-160) showed what that means for an
-- entry nobody identified: an unplated **petrol** vehicle in litres resolves to the **diesel** factor, and so
-- does its business-travel and commuting variant. Litres is a fuel *quantity*; it says nothing about which
-- fuel. It is the NZC-151 silent downgrade — a coarser rule answering for something it cannot know — reached
-- through the unit instead of through a lookup.
--
-- ## Deactivated, not deleted
--
-- `active = false` and the version bumped, as every governed vocabulary here is retired. The row stays
-- readable: the characterisation, NZC-149's history and anyone reading an old outcome's `rule.ruleKey` can
-- still find what it said. The resolver reads active rules only, so from here an unplated vehicle entry in
-- litres has no declared answer and goes to a person — the search, never the ILIKE (NZC-160 H6).
--
-- The DVLA rule (`dvla-diesel`, 0113) is untouched: a plate the lookup identifies as diesel still resolves,
-- because there the fuel is known rather than guessed.
--
-- ## Refuses unless the row is the one that was characterised
--
-- A migration that quietly updated zero rows, or a row that had since been changed to mean something else,
-- would report success and fix nothing. So this states what it expects to find — active, a basis-branch on
-- `unit = litres` pricing `diesel-demo` — and stops with a message if that is not what is there.

BEGIN;

DO $$
DECLARE changed integer;
BEGIN
  UPDATE nzi_console.input_spec_factor_rules
     SET active = false,
         version = version + 1,
         updated_at = now(),
         updated_by = 'migration:0119',
         note = note || ' Deactivated by 0119 (NZC-160 D3): a unit alone does not identify a fuel, so an unplated petrol vehicle in litres was priced as diesel.'
   WHERE category_code = '1.company-vehicles'
     AND rule_key = 'fuel-litres'
     AND active
     AND rule_kind = 'basis-branch'
     AND basis_field_key = 'unit'
     AND lower(basis_value) = 'litres'
     AND factor_base = 'diesel-demo';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION '0119 expected exactly one active fuel-litres rule (basis-branch, unit = litres, diesel-demo) and found %. It has been changed or removed since NZC-160 characterised it; establish what it now says before deactivating it.', changed;
  END IF;
END $$;

COMMIT;
