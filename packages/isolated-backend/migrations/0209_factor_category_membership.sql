-- 0209 Which factors belong to which category: a reviewable map from the DESNZ source levels each factor already stores
-- (NZC-171; ruled by Cowork, RULING-factor-category-membership.md).
--
-- ## Why
--
-- A factor carries its scope (1/2/3) and nothing about its category. Every category below Scope was therefore offered every factor of
-- its scope: freight and embodied carbon were reachable from Employee Commuting before a character was typed. The category is already
-- in the data - DESNZ's own taxonomy is stored on every factor as `emission_factors.source_levels` (saved, never read until now) - so
-- the membership is derived from it, through a map a person reviews, not a list kept in code.
--
-- ## What this adds
--
-- `factor_category_membership`: a rule is (level 1, optional level 2, optional level 3) -> category. An absent level is "any", so
-- `Business travel- land` files every vehicle under it while `Fuels / Gaseous fuels / Natural gas` files one fuel. Several rules may name
-- one family (a family may belong to several categories) and several families one category. Levels compare case-insensitively with runs
-- of whitespace collapsed - the source data carries double spaces and newlines.
--
-- A rule with no category (`category_code` NULL) holds a family back until its category exists. It is known, not unfiled: DESNZ "Heat and
-- steam" (Scope 2) has no category yet, and filing it under purchased electricity would be wrong (ruling 7).
--
-- Global, not per-organisation: the DESNZ taxonomy and the GHG categories are the same for every client of every firm (NZC-102), as the
-- category registry (0110) is. A rule is never deleted or re-pointed - its history is the audit - it is retired and, if the family
-- moves, a new rule is added. Written by `factor.manage` (Admin).
--
-- ## What it does not change
--
-- No factor, value, row or report. Spend factors (priced in a currency) are not in the DESNZ taxonomy and carry no rule: they belong to
-- the spend categories and to the category an applicability pair names (Rule S), which the read decides. A variant id (`<base>-c`)
-- belongs to the category its suffix names. A category no rule names (3.10, 3.11, 3.14, 3.15) has no family of its own and is
-- offered the whole scope, with a notice.
--
-- EV charging electricity ("UK electricity for EVs") is filed under 2.purchased-electricity only. The ruling allowed it under
-- 1.company-vehicles as well, on condition that the row be reported as Scope 2 wherever it was entered; the row model keys scope off
-- the category and a Scope 2 row needs its own method and supply fields, so the dual membership is not shipped (see the PR note).

CREATE TABLE nzi_console.factor_category_membership (
  rule_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_l1 text NOT NULL CONSTRAINT factor_category_membership_l1 CHECK (btrim(source_l1) <> ''),
  source_l2 text CONSTRAINT factor_category_membership_l2 CHECK (source_l2 IS NULL OR btrim(source_l2) <> ''),
  source_l3 text CONSTRAINT factor_category_membership_l3 CHECK (source_l3 IS NULL OR btrim(source_l3) <> ''),
  CONSTRAINT factor_category_membership_l3_needs_l2 CHECK (source_l2 IS NOT NULL OR source_l3 IS NULL),
  -- A data-entry category code (NZC-046 taxonomy), or NULL to hold the family back.
  category_code text CONSTRAINT factor_category_membership_category CHECK (category_code IS NULL OR category_code ~ '^([12]\.[a-z]+(-[a-z]+)*|3\.([1-9]|1[0-5]))$'),
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  retired_at timestamptz,
  retired_by text,
  CONSTRAINT factor_category_membership_retired_shape CHECK ((status = 'retired') = (retired_at IS NOT NULL AND retired_by IS NOT NULL)),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source text NOT NULL DEFAULT 'migration' CHECK (source IN ('migration', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL
);

-- One rule per (family, category), however it was spelled.
CREATE UNIQUE INDEX factor_category_membership_one_rule ON nzi_console.factor_category_membership (
  lower(btrim(regexp_replace(source_l1, '\s+', ' ', 'g'))),
  coalesce(lower(btrim(regexp_replace(source_l2, '\s+', ' ', 'g'))), ''),
  coalesce(lower(btrim(regexp_replace(source_l3, '\s+', ' ', 'g'))), ''),
  coalesce(category_code, ''));

COMMENT ON TABLE nzi_console.factor_category_membership IS
  'Which DESNZ source-level families a data-entry category offers (NZC-171). A rule is (L1, optional L2, optional L3) -> category; an absent level is any. category_code NULL holds a family back until its category exists. Never deleted or re-pointed: retire and add.';

CREATE FUNCTION nzi_console.factor_category_membership_is_permanent()
RETURNS trigger
LANGUAGE plpgsql SET search_path = nzi_console, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A membership rule is never deleted: retire it, and add the replacement.' USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW.source_l1 IS DISTINCT FROM OLD.source_l1 OR NEW.source_l2 IS DISTINCT FROM OLD.source_l2 OR NEW.source_l3 IS DISTINCT FROM OLD.source_l3
     OR NEW.category_code IS DISTINCT FROM OLD.category_code THEN
    RAISE EXCEPTION 'A membership rule is never re-pointed: %/%/% -> % would silently re-file every factor it claims. Retire it and add the replacement.',
      OLD.source_l1, OLD.source_l2, OLD.source_l3, OLD.category_code USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER factor_category_membership_is_permanent
  BEFORE UPDATE OR DELETE ON nzi_console.factor_category_membership
  FOR EACH ROW EXECUTE FUNCTION nzi_console.factor_category_membership_is_permanent();

GRANT SELECT, INSERT, UPDATE ON nzi_console.factor_category_membership TO nzi_console_app;
GRANT SELECT ON nzi_console.factor_category_membership TO nzi_console_worker;
REVOKE DELETE ON nzi_console.factor_category_membership FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

-- ── The ruled map ───────────────────────────────────────────────────────────────────────────────────────────────────

INSERT INTO nzi_console.factor_category_membership (source_l1, source_l2, source_l3, category_code, note, created_by, updated_by)
SELECT v.l1, v.l2, v.l3, v.category, v.note, 'migration:0209', 'migration:0209'
  FROM (VALUES
    -- Scope 1. Natural gas is every natural-gas level 3; the other gases are Other Stationary Fuels (ruling 1).
    ('Fuels', 'Gaseous fuels', 'Natural gas', '1.natural-gas', 'Natural gas'),
    ('Fuels', 'Gaseous fuels', 'Natural gas (100% mineral blend)', '1.natural-gas', 'Natural gas, mineral blend (ruling 1: not split from natural gas)'),
    ('Fuels', 'Gaseous fuels', 'Butane', '1.other-stationary-fuels', 'A fuel other than natural gas'),
    ('Fuels', 'Gaseous fuels', 'CNG', '1.other-stationary-fuels', 'A fuel other than natural gas'),
    ('Fuels', 'Gaseous fuels', 'LNG', '1.other-stationary-fuels', 'A fuel other than natural gas'),
    ('Fuels', 'Gaseous fuels', 'LPG', '1.other-stationary-fuels', 'A fuel other than natural gas'),
    ('Fuels', 'Gaseous fuels', 'Propane', '1.other-stationary-fuels', 'A fuel other than natural gas'),
    ('Fuels', 'Gaseous fuels', 'Other petroleum gas', '1.other-stationary-fuels', 'A fuel other than natural gas'),
    ('Fuels', 'Gaseous fuels', 'Green gas', '1.other-stationary-fuels', 'Renewable gas (NZI custom factors): a fuel other than natural gas'),
    ('Fuels', 'Liquid fuels', NULL, '1.other-stationary-fuels', 'Liquid fuels burned in fixed plant'),
    ('Fuels', 'Liquid fuels', NULL, '1.company-vehicles', 'Liquid fuels burned in vehicles - the vehicle pairs (-vcd -vcp -vh -vvd) draw on these bases'),
    ('Fuels', 'Solid fuels', NULL, '1.other-stationary-fuels', 'Solid fuels burned in fixed plant'),
    ('Bioenergy', NULL, NULL, '1.other-stationary-fuels', 'Biofuel, biogas and biomass'),
    ('Passenger vehicles', NULL, NULL, '1.company-vehicles', 'Cars and motorbikes (Scope 1)'),
    ('Delivery vehicles', NULL, NULL, '1.company-vehicles', 'Vans and HGVs (Scope 1)'),
    ('Refrigerant & other', NULL, NULL, '1.refrigerants', 'Refrigerants and other fugitive gases'),
    -- Scope 2. EV charging is Scope 2 and is filed under purchased electricity alone (see the header). Renewable electricity is its own
    -- category (ruling 6). Heat and steam is held back until a Scope 2 heat category exists (ruling 7).
    ('UK electricity', 'Electricity generated', NULL, '2.purchased-electricity', 'UK grid electricity'),
    ('UK electricity for EVs', NULL, NULL, '2.purchased-electricity', 'EV charging is Scope 2 (ruling 5: the dual company-vehicles membership is not shipped - see the PR note)'),
    ('Electricity Generation', NULL, NULL, '2.purchased-electricity', 'Grid electricity by country (IEA)'),
    ('UK Renewable Electricity', NULL, NULL, '2.renewable-electricity', 'Renewable electricity only (ruling 6)'),
    ('Heat and steam', NULL, NULL, NULL, 'Held back: purchased heat and steam is Scope 2 and has no category yet (ruling 7). To be filed under 2.purchased-heat-steam.'),
    -- Scope 3.3 Fuel & energy related: well-to-tank and transmission & distribution of energy.
    ('Transmission and distribution', NULL, NULL, '3.3', 'T&D losses'),
    ('UK electricity T&D for EVs', NULL, NULL, '3.3', 'T&D of EV charging electricity'),
    ('WTT- fuels', NULL, NULL, '3.3', 'Well-to-tank of fuels'),
    ('WTT- bioenergy', NULL, NULL, '3.3', 'Well-to-tank of bioenergy'),
    ('WTT- UK electricity', NULL, NULL, '3.3', 'Well-to-tank of electricity'),
    ('WTT- UK & overseas elec', NULL, NULL, '3.3', 'Well-to-tank of electricity'),
    ('WTT- heat and steam', NULL, NULL, '3.3', 'Well-to-tank of heat and steam'),
    -- Freight: upstream and downstream (the -d pairs draw on the same bases).
    ('Freighting goods', NULL, NULL, '3.4', 'Freight'),
    ('Freighting goods', NULL, NULL, '3.9', 'Freight'),
    ('WTT- delivery vehs & freight', NULL, NULL, '3.4', 'Well-to-tank of freight mirrors freight (ruling 2)'),
    ('WTT- delivery vehs & freight', NULL, NULL, '3.9', 'Well-to-tank of freight mirrors freight (ruling 2)'),
    -- Waste and water.
    ('Waste disposal', NULL, NULL, '3.5', 'Waste generated in operations'),
    ('Waste disposal', NULL, NULL, '3.12', 'End-of-life treatment of sold products'),
    ('Water treatment', NULL, NULL, '3.5', 'Water treatment'),
    ('Water supply', NULL, NULL, '3.1', 'Water supply is a purchased good'),
    -- Business travel and commuting. Land and sea travel serve both; air serves business travel alone (the commuting pairs draw on exactly this).
    ('Business travel- air', NULL, NULL, '3.6', 'Flights'),
    ('Business travel- land', NULL, NULL, '3.6', 'Bus, car, motorbike, rail, taxi, walking, cycling'),
    ('Business travel- land', NULL, NULL, '3.7', 'The commuting pairs (-c) draw on these bases'),
    ('Business travel- sea', NULL, NULL, '3.6', 'Ferry'),
    ('Business travel- sea', NULL, NULL, '3.7', 'The commuting ferry pair draws on these bases'),
    ('WTT- business travel- air', NULL, NULL, '3.6', 'Well-to-tank of flights'),
    ('WTT- business travel- sea', NULL, NULL, '3.6', 'Well-to-tank of ferries'),
    ('WTT- pass vehs & travel- land', NULL, NULL, '3.6', 'Well-to-tank of land travel mirrors it (ruling 2)'),
    ('WTT- pass vehs & travel- land', NULL, NULL, '3.7', 'Well-to-tank of land travel mirrors it (ruling 2)'),
    ('Hotel stay', NULL, NULL, '3.6', 'Hotel nights'),
    ('Business Travel - Petrol Car', NULL, NULL, '3.6', 'Legacy NZI business-travel car ids from the v7 import'),
    ('Business Travel - Petrol Car - litres', NULL, NULL, '3.6', 'Legacy NZI business-travel car ids from the v7 import'),
    ('Employee commuting- land', NULL, NULL, '3.7', 'DESNZ commuting rows'),
    ('Homeworking', NULL, NULL, '3.7', 'Home working (ruling 3)'),
    -- Materials: bought (3.1) or capitalised (3.2).
    ('Material use', NULL, NULL, '3.1', 'Materials bought'),
    ('Material use', NULL, NULL, '3.2', 'Materials in capital goods'),
    -- Leased assets: upstream (3.8) and downstream (3.13).
    ('Managed assets- vehicles', NULL, NULL, '3.8', 'Leased vehicles'),
    ('Managed assets- vehicles', NULL, NULL, '3.13', 'Leased vehicles'),
    ('Managed assets- electricity', NULL, NULL, '3.8', 'Leased assets electricity'),
    ('Managed assets- electricity', NULL, NULL, '3.13', 'Leased assets electricity')
  ) AS v(l1, l2, l3, category, note);

-- ICE embodied carbon: one level 1 per material, each bought (3.1) or capitalised (3.2).
INSERT INTO nzi_console.factor_category_membership (source_l1, source_l2, source_l3, category_code, note, created_by, updated_by)
SELECT m.material, NULL, NULL, c.category, 'ICE embodied carbon: ' || m.material, 'migration:0209', 'migration:0209'
  FROM unnest(ARRAY['Aggregates and Sand', 'Aluminium', 'Asphalt', 'Bitumen', 'Brass', 'Bricks', 'Bronze', 'Carpet', 'Cement and Mortar', 'Ceramics',
    'Clay', 'Concrete', 'Copper', 'Glass', 'Insulation', 'Iron', 'Lead', 'Lime', 'Linoleum', 'Miscellaneous', 'Paint', 'Paper', 'Plaster', 'Plastics',
    'Rubber', 'Sealants and Adhesives', 'Soil', 'Steel', 'Stone', 'Timber', 'Tin', 'Titanium', 'Vinyl', 'Zinc']) AS m(material)
  CROSS JOIN (VALUES ('3.1'), ('3.2')) AS c(category);

-- The seed is audited once per organisation, as a set: the table is global, so the event says what was filed and by which migration.
INSERT INTO nzi_console.audit_events
  (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, after_json)
SELECT o.organisation_id, gen_random_uuid()::text, 'migration:0209', 'system', 'factor.membership.seeded', 'factor_category_membership', '0209', 'migration:0209',
       'NZC-171: the ruled DESNZ family -> category map (RULING-factor-category-membership.md), seeded.',
       jsonb_build_object('rules', (SELECT count(*) FROM nzi_console.factor_category_membership),
                          'heldBack', (SELECT count(*) FROM nzi_console.factor_category_membership WHERE category_code IS NULL),
                          'categories', (SELECT count(DISTINCT category_code) FROM nzi_console.factor_category_membership))
  FROM nzi_console.organisations o;

DO $$
BEGIN
  IF (SELECT count(*) FROM nzi_console.factor_category_membership) <> 56 + 68 THEN
    RAISE EXCEPTION '0209: expected 124 membership rules, found %', (SELECT count(*) FROM nzi_console.factor_category_membership);
  END IF;
  IF (SELECT count(*) FROM nzi_console.factor_category_membership WHERE category_code IS NULL) <> 1 THEN
    RAISE EXCEPTION '0209: exactly one family (Heat and steam) is held back';
  END IF;
END $$;
