BEGIN;

-- 0080 — Reference data follows the organisation, instead of the migration that ran once.
--
-- The SRS framework, the levers and the strategy library are seeded with
-- `INSERT ... SELECT ... FROM nzi_console.organisations`. That covers every organisation
-- that existed WHEN THE MIGRATION RAN, and nothing re-runs it — so an organisation created
-- afterwards gets no framework, no levers and no library, silently. It is not a theory: the
-- migrations CI run surfaced it, and a client onboarded today would hit the same missing
-- `srs_frameworks` that took staging down.
--
-- So provisioning becomes a thing that happens TO AN ORGANISATION rather than a thing a
-- migration did once:
--
--   * `provision_organisation(id)` — idempotent, gives one organisation the current
--     reference set, and skips anything it already has.
--   * a trigger on `organisations` — because nothing in this repo creates an organisation.
--     They arrive by script or by hand, so a command would be a hook nothing calls. A
--     trigger cannot be bypassed by whichever path is used next.
--   * a backfill for the organisations that already exist.
--
-- The seed rows below are lifted verbatim from 0070 / 0075 / 0078 by
-- `scripts/generate-provisioning.ts` rather than retyped, so they cannot differ by a
-- transcription slip. A CI test asserts a newly provisioned organisation matches a
-- migration-seeded one, which guards against drift from here on.
--
-- Everything is guarded by `NOT EXISTS` / `ON CONFLICT DO NOTHING`: provisioning an
-- organisation twice is a no-op, which is what makes the trigger and the backfill safe to
-- run over each other.

CREATE OR REPLACE FUNCTION nzi_console.provision_organisation(p_organisation_id text)
RETURNS void LANGUAGE plpgsql AS $provision$
BEGIN
  -- ── UK SRS framework ───────────────────────────────────────────────────────────────
  -- Skipped wholesale when the organisation already has a framework: re-seeding v1 next to
  -- a v2 somebody published would give it two, and "one active version" is the rule.
  IF NOT EXISTS (SELECT 1 FROM nzi_console.srs_frameworks WHERE organisation_id = p_organisation_id) THEN
  INSERT INTO nzi_console.srs_frameworks (organisation_id, framework_id, version, label, status, effective_from, notes, published_by)
  SELECT p_organisation_id, 'uk-srs-2026', 1, 'UK SRS S1 & S2 (2026)', 'active', DATE '2026-02-25',
    'UK-endorsed IFRS S1 and S2 as published on 25 February 2026. Voluntary; mandatory requirements proposed for 2027 will be published as the next framework version.',
    'migration:0070';

  INSERT INTO nzi_console.srs_standards (organisation_id, framework_id, standard_key, label, description, climate_led, ordering)
  SELECT p_organisation_id, 'uk-srs-2026', v.standard_key, v.label, v.description, v.climate_led, v.ordering
  FROM (VALUES
      ('S2', 'UK SRS S2 — Climate', 'Climate-related disclosures: the deeper, more prescriptive standard, and where readiness effort lands first.', true, 1),
      ('S1', 'UK SRS S1 — General', 'General sustainability-related financial disclosures, covering any material sustainability risk or opportunity.', false, 2)
    ) AS v(standard_key, label, description, climate_led, ordering);

  INSERT INTO nzi_console.srs_pillars (organisation_id, framework_id, pillar_key, label, description, ordering)
  SELECT p_organisation_id, 'uk-srs-2026', v.pillar_key, v.label, v.description, v.ordering
  FROM (VALUES
      ('governance', 'Governance', 'Board and management oversight of sustainability-related risks and opportunities.', 1),
      ('strategy', 'Strategy', 'Material risks and opportunities, their effects on the business model, strategy and financial position, and climate resilience.', 2),
      ('risk', 'Risk management', 'How sustainability risks are identified, assessed, managed and integrated into enterprise risk.', 3),
      ('metrics', 'Metrics & targets', 'The GHG inventory, cross-industry and industry-based metrics, and the targets set.', 4)
    ) AS v(pillar_key, label, description, ordering);

  INSERT INTO nzi_console.srs_maturity_levels (organisation_id, framework_id, level, key, label, definition)
  SELECT p_organisation_id, 'uk-srs-2026', v.level, v.key, v.label, v.definition
  FROM (VALUES
      (0, 'not-started', 'Not started', 'Nothing is in place for this requirement yet.'),
      (1, 'developing', 'Developing', 'Work has begun: an approach exists but it is partial, informal or undocumented.'),
      (2, 'established', 'Established', 'A documented approach is in place and operating — the disclosure could be made.'),
      (3, 'advanced', 'Advanced', 'The approach is embedded, reviewed and evidenced, and meets the standard in full.'),
      (4, 'assured', 'Assured', 'Independently assured or externally verified, and ready to withstand scrutiny.')
    ) AS v(level, key, label, definition);

  INSERT INTO nzi_console.srs_requirements (organisation_id, framework_id, requirement_id, standard_key, pillar_key, code, title, help_text, weight, source, nzi_source_key, target_maturity, ordering)
  SELECT p_organisation_id, 'uk-srs-2026', v.requirement_id, v.standard_key, v.pillar_key, v.code, v.title, v.help_text, v.weight, v.source, v.nzi_source_key, v.target_maturity, v.ordering
  FROM (VALUES
      -- S2 · Governance
      ('s2-g1','S2','governance','S2 G1','Board body responsible for climate is identified','Name the board or committee with oversight of climate-related risks and opportunities, and say where that responsibility is recorded.',1.00,'entered',NULL,2,1),
      ('s2-g2','S2','governance','S2 G2','Terms of reference reflect climate responsibilities','The body''s terms of reference, charter or mandate explicitly cover climate-related matters.',1.00,'entered',NULL,2,2),
      ('s2-g3','S2','governance','S2 G3','Management''s role and reporting lines are defined','Which management roles assess and manage climate risks, and how they report upward.',1.00,'entered',NULL,2,3),
      ('s2-g4','S2','governance','S2 G4','Climate competence of the oversight body','How the board ensures it has the skills and information to oversee climate matters, including training.',1.00,'entered',NULL,2,4),
      ('s2-g5','S2','governance','S2 G5','Frequency of climate reporting to the board','How often, and through what route, climate matters reach the oversight body.',1.00,'entered',NULL,2,5),
      ('s2-g6','S2','governance','S2 G6','Climate in performance and remuneration','Whether climate-related targets form part of remuneration policies, and how.',0.50,'entered',NULL,1,6),
      -- S2 · Strategy
      ('s2-s1','S2','strategy','S2 S1','Climate risks and opportunities identified with time horizons','The specific climate risks and opportunities that could reasonably affect prospects, over short, medium and long term as the entity defines them.',1.50,'entered',NULL,2,1),
      ('s2-s2','S2','strategy','S2 S2','Effects on the business model and value chain','Where in the business model and value chain the identified risks and opportunities are concentrated.',1.00,'entered',NULL,2,2),
      ('s2-s3','S2','strategy','S2 S3','Effects on strategy and decision-making','How climate risks and opportunities have changed, or are expected to change, strategy and decision-making.',1.00,'entered',NULL,2,3),
      ('s2-s4','S2','strategy','S2 S4','Effects on financial position, performance and cash flows','Current financial effects, and those anticipated over the short, medium and long term.',1.50,'entered',NULL,2,4),
      ('s2-s5','S2','strategy','S2 S5','Climate resilience assessed through scenario analysis','Whether resilience has been assessed using climate-related scenario analysis, and what it showed.',1.50,'entered',NULL,2,5),
      ('s2-s6','S2','strategy','S2 S6','Scenario method, inputs and assumptions disclosed','Which scenarios were used, why they were chosen, and the key inputs and assumptions behind them.',1.00,'entered',NULL,2,6),
      ('s2-s7','S2','strategy','S2 S7','Transition plan, with assumptions and dependencies','Any climate-related transition plan, including the assumptions it rests on and what it depends on to be delivered.',1.50,'entered',NULL,2,7),
      ('s2-s8','S2','strategy','S2 S8','Planned use of carbon credits is explained','If credits are relied on, the extent, the type, and whether they are removals or reductions.',0.50,'entered',NULL,1,8),
      -- S2 · Risk management
      ('s2-r1','S2','risk','S2 R1','Process to identify and assess climate risks','The process used, including the inputs and parameters it relies on.',1.00,'entered',NULL,2,1),
      ('s2-r2','S2','risk','S2 R2','Climate risks are prioritised against other risks','How climate risks are weighed relative to the entity''s other risk types.',1.00,'entered',NULL,2,2),
      ('s2-r3','S2','risk','S2 R3','Process to monitor and manage climate risks','How identified risks are monitored, escalated and managed over time.',1.00,'entered',NULL,2,3),
      ('s2-r4','S2','risk','S2 R4','Integration into enterprise risk management','How the climate process is integrated into, rather than parallel to, the overall risk framework.',1.00,'entered',NULL,2,4),
      ('s2-r5','S2','risk','S2 R5','Process to identify climate opportunities','The equivalent process for opportunities, not only risks.',0.50,'entered',NULL,1,5),
      -- S2 · Metrics & targets — answered from the client''s own assured record where possible
      ('s2-m1','S2','metrics','S2 M1','Scope 1 gross GHG emissions disclosed','Gross Scope 1 emissions for the reporting period, in tonnes of CO2 equivalent.',1.50,'nzi-data','footprint.scope1',3,1),
      ('s2-m2','S2','metrics','S2 M2','Scope 2 gross GHG emissions disclosed','Gross Scope 2 emissions, location-based, with market-based disclosed where relevant.',1.50,'nzi-data','footprint.scope2',3,2),
      ('s2-m3','S2','metrics','S2 M3','Scope 3 GHG emissions disclosed by category','Scope 3 emissions with the categories included, and the basis for any exclusion.',1.50,'nzi-data','footprint.scope3',3,3),
      ('s2-m4','S2','metrics','S2 M4','Measurement approach, inputs and assumptions','The approach used to measure emissions — the GHG Protocol basis, the boundary, and the assumptions applied.',1.00,'nzi-data','footprint.method',3,4),
      ('s2-m5','S2','metrics','S2 M5','Emission factor sources and vintages disclosed','Which factor sets were used, their versions, and the date they were applied as at.',1.00,'nzi-data','footprint.provenance',3,5),
      ('s2-m6','S2','metrics','S2 M6','Climate-related targets disclosed','The metric, objective, period covered and base year for each target set.',1.50,'nzi-data','targets.model',3,6),
      ('s2-m7','S2','metrics','S2 M7','Progress against targets reported','Performance against each target, measured from the base year.',1.00,'nzi-data','targets.gap',3,7),
      ('s2-m8','S2','metrics','S2 M8','Intensity metrics disclosed','Emissions normalised against a business measure, with the denominator stated.',1.00,'nzi-data','intensity.metrics',2,8),
      ('s2-m9','S2','metrics','S2 M9','Industry-based metrics considered','Whether industry-based metrics have been considered and, where applicable, disclosed.',0.50,'entered',NULL,1,9),
      ('s2-m10','S2','metrics','S2 M10','Internal carbon price disclosed, if used','Whether an internal carbon price is applied, the price, and how it is used in decisions.',0.50,'entered',NULL,1,10),
      ('s2-m11','S2','metrics','S2 M11','Assets or activities vulnerable to climate risk quantified','The amount or percentage of assets and business activities vulnerable to transition and to physical risk.',1.00,'entered',NULL,2,11),
      ('s2-m12','S2','metrics','S2 M12','Capital deployed toward climate risks and opportunities','The amount of capital expenditure, financing or investment deployed toward climate-related risks and opportunities.',1.00,'entered',NULL,2,12),
      ('s2-m13','S2','metrics','S2 M13','GHG inventory independently assured','Whether the inventory has been externally verified or assured, by whom, and to what standard.',1.00,'nzi-data','footprint.assurance',2,13),
      -- S1 · Governance
      ('s1-g1','S1','governance','S1 G1','Oversight of sustainability risks beyond climate','The governance body responsible for sustainability-related risks and opportunities generally, not only climate.',1.00,'entered',NULL,2,1),
      ('s1-g2','S1','governance','S1 G2','Management''s role in sustainability governance','The management roles responsible, and how oversight is exercised over them.',1.00,'entered',NULL,2,2),
      ('s1-g3','S1','governance','S1 G3','Controls and procedures support the disclosures','The controls and procedures that make the sustainability disclosures reliable.',1.00,'entered',NULL,2,3),
      -- S1 · Strategy
      ('s1-s1','S1','strategy','S1 S1','Material sustainability risks and opportunities identified','Which sustainability-related risks and opportunities could reasonably affect prospects, and how materiality was judged.',1.50,'entered',NULL,2,1),
      ('s1-s2','S1','strategy','S1 S2','Effects on business model, strategy and financial position','The effects of those risks and opportunities, current and anticipated.',1.00,'entered',NULL,2,2),
      ('s1-s3','S1','strategy','S1 S3','Time horizons defined and applied consistently','How short, medium and long term are defined, and their consistency with planning horizons.',0.50,'entered',NULL,2,3),
      -- S1 · Risk management
      ('s1-r1','S1','risk','S1 R1','Process to identify, assess and prioritise sustainability risks','The process covering sustainability risks generally.',1.00,'entered',NULL,2,1),
      ('s1-r2','S1','risk','S1 R2','Integration with enterprise risk management','How that process sits inside the overall risk framework.',1.00,'entered',NULL,2,2),
      -- S1 · Metrics & targets, and the reporting mechanics S1 governs
      ('s1-m1','S1','metrics','S1 M1','Metrics disclosed for each material topic','A metric for each material sustainability topic, with its basis of preparation.',1.00,'entered',NULL,2,1),
      ('s1-m2','S1','metrics','S1 M2','Targets and progress for material topics','Targets set for material topics, and performance against them.',1.00,'entered',NULL,2,2),
      ('s1-m3','S1','metrics','S1 M3','Reporting boundary matches the financial statements','The sustainability disclosures cover the same reporting entity as the financial statements.',1.00,'entered',NULL,2,3),
      ('s1-m4','S1','metrics','S1 M4','Comparatives and restatement policy','Comparative information is given, and the policy for restating it is disclosed.',1.00,'entered',NULL,2,4),
      ('s1-m5','S1','metrics','S1 M5','Connected information','The links between the sustainability disclosures and the financial statements are explained.',1.00,'entered',NULL,2,5),
      ('s1-m6','S1','metrics','S1 M6','Statement of compliance with UK SRS','An explicit statement of compliance, where compliance is claimed.',1.00,'entered',NULL,2,6),
      ('s1-m7','S1','metrics','S1 M7','Judgements, uncertainties and estimates disclosed','The significant judgements made, and the measurement uncertainties behind the figures.',1.00,'entered',NULL,2,7),
      ('s1-m8','S1','metrics','S1 M8','Reporting timed with the financial report','Sustainability disclosures are published at the same time as the related financial statements.',0.50,'entered',NULL,2,8)
    ) AS v(requirement_id, standard_key, pillar_key, code, title, help_text, weight, source, nzi_source_key, target_maturity, ordering);
  END IF;

  -- ── Reduction levers ───────────────────────────────────────────────────────────────
  INSERT INTO nzi_console.levers (organisation_id, lever_id, lever_key, title, icon_key, ordering, created_by)
  SELECT p_organisation_id, 'lever-' || seed.lever_key, seed.lever_key, seed.title, seed.icon, seed.ordering, 'system:0078'
  FROM (VALUES
    ('energy',      'Energy',              'energy',    1),
    ('buildings',   'Buildings & sites',   'building',  2),
    ('transport',   'Transport & travel',  'vehicle',   3),
    ('procurement', 'Procurement & supply chain', 'handshake', 4),
    ('process',     'Process & operations', 'tools',    5),
    ('waste',       'Waste & materials',   'recycle',   6),
    ('governance',  'Governance & policy', 'policy',    7)
  ) AS seed(lever_key, title, icon, ordering)
  ON CONFLICT DO NOTHING;

  -- ── The strategy library ───────────────────────────────────────────────────────────
  INSERT INTO nzi_console.reduction_strategies
    (organisation_id, strategy_id, strategy_key, title, scope, category, control_level, icon_key, description, created_by)
  SELECT p_organisation_id, 'lever-' || seed.strategy_key, seed.strategy_key, seed.title, seed.scope, seed.category,
         seed.sphere, seed.icon, seed.description, 'system:0075'
  FROM (VALUES
    ('renewable-tariff',      'Switch to a certified renewable electricity tariff', '2', 'Energy',            'direct_control', 'energy',    'Move supplied electricity onto a tariff backed by retired certificates.'),
    ('solar-pv',              'On-site solar PV generation',                        '2', 'Energy',            'direct_control', 'solar',     'Generate on site to displace supplied electricity.'),
    ('heat-pump',             'Heat-pump conversion',                               '1', 'Heating',           'direct_control', 'energy',    'Replace gas or oil heating with electric heat pumps.'),
    ('led-bms',               'LED and building-management upgrade',                '2', 'Energy efficiency', 'direct_control', 'tools',     'Reduce demand before switching supply.'),
    ('ev-fleet',              'Green fleet / EV transition',                        '1', 'Transport',         'direct_control', 'vehicle',   'Replace combustion vehicles as they come up for renewal.'),
    ('waste-reduction',       'Waste reduction and recycling',                      '3', 'Cat 5 · Waste',     'direct_control', 'waste',     'Cut waste generated in operations and divert what remains.'),
    ('supplier-engagement',   'Supplier engagement programme',                      '3', 'Cat 1 · Procurement', 'supply_chain', 'handshake', 'Work with the largest suppliers by spend on their own reductions.'),
    ('sustainable-procurement', 'Sustainable procurement policy',                   '3', 'Cat 1 · Procurement', 'supply_chain', 'policy',    'Make carbon a scored criterion in purchasing decisions.'),
    ('recycled-packaging',    'Switch to recycled-content packaging',               '3', 'Cat 1 · Materials', 'supply_chain',   'package',   'Reduce embodied carbon in packaging materials.'),
    ('rail-first-travel',     'Business-travel policy — rail-first',                '3', 'Cat 6 · Travel',    'supply_chain',   'flight',    'Set rail as the default for journeys where it is viable.'),
    ('commuting-plan',        'Employee commuting survey and plan',                 '3', 'Cat 7 · Commuting', 'influence',      'bus',       'Measure how staff travel to work, then act on what it shows.'),
    ('product-take-back',     'Customer product take-back scheme',                  '3', 'Cat 12 · Circularity', 'influence',   'recycle',   'Recover products at end of life to displace virgin material.'),
    ('supplier-code',         'Publish a supplier code of conduct',                 'governance', 'Governance', 'influence',    'document',  'Set out what the business expects of its suppliers on climate.')
  ) AS seed(strategy_key, title, scope, category, sphere, icon, description)
  ON CONFLICT DO NOTHING;

  -- ── Allocate the library to levers ─────────────────────────────────────────────────
  -- Same mapping 0078 applied, keyed on the stable keys rather than generated ids.
  INSERT INTO nzi_console.strategy_levers (organisation_id, strategy_id, lever_id)
  SELECT s.organisation_id, s.strategy_id, l.lever_id
  FROM nzi_console.reduction_strategies s
  JOIN nzi_console.levers l ON l.organisation_id = s.organisation_id
  WHERE s.organisation_id = p_organisation_id
    AND (s.strategy_key, l.lever_key) IN (
      ('renewable-tariff', 'energy'),
      ('solar-pv', 'energy'), ('solar-pv', 'buildings'),
      ('heat-pump', 'energy'), ('heat-pump', 'buildings'),
      ('led-bms', 'energy'), ('led-bms', 'buildings'),
      ('ev-fleet', 'transport'),
      ('waste-reduction', 'waste'),
      ('supplier-engagement', 'procurement'),
      ('sustainable-procurement', 'procurement'), ('sustainable-procurement', 'governance'),
      ('recycled-packaging', 'procurement'), ('recycled-packaging', 'waste'),
      ('rail-first-travel', 'transport'), ('rail-first-travel', 'governance'),
      ('commuting-plan', 'transport'),
      ('product-take-back', 'waste'),
      ('supplier-code', 'governance')
    )
  ON CONFLICT DO NOTHING;

  -- A strategy with no lever would not render in a plan grouped by lever, so anything the
  -- mapping missed lands under Process & operations rather than vanishing.
  INSERT INTO nzi_console.strategy_levers (organisation_id, strategy_id, lever_id)
  SELECT s.organisation_id, s.strategy_id, l.lever_id
  FROM nzi_console.reduction_strategies s
  JOIN nzi_console.levers l ON (l.organisation_id, l.lever_key) = (s.organisation_id, 'process')
  WHERE s.organisation_id = p_organisation_id
    AND NOT EXISTS (
      SELECT 1 FROM nzi_console.strategy_levers x
      WHERE (x.organisation_id, x.strategy_id) = (s.organisation_id, s.strategy_id)
    )
  ON CONFLICT DO NOTHING;
END
$provision$;

COMMENT ON FUNCTION nzi_console.provision_organisation(text) IS
  'Gives one organisation the current reference set: the SRS framework, the levers and the strategy library. Idempotent — provisioning twice is a no-op, which is what lets the trigger and the backfill run over each other safely.';

-- ── The trigger ──────────────────────────────────────────────────────────────────────
--
-- Nothing in this repository creates an organisation: they arrive by script or by hand. A
-- command would therefore be a hook nothing calls, and the gap would reopen the first time
-- someone inserted a row directly — which is exactly how it opened in the first place.

CREATE OR REPLACE FUNCTION nzi_console.provision_new_organisation()
RETURNS trigger LANGUAGE plpgsql AS $trigger$
BEGIN
  PERFORM nzi_console.provision_organisation(NEW.organisation_id);
  RETURN NEW;
END
$trigger$;

DROP TRIGGER IF EXISTS provision_on_insert ON nzi_console.organisations;
CREATE TRIGGER provision_on_insert
  AFTER INSERT ON nzi_console.organisations
  FOR EACH ROW EXECUTE FUNCTION nzi_console.provision_new_organisation();

COMMENT ON FUNCTION nzi_console.provision_new_organisation() IS
  'Provisions reference data for a newly inserted organisation, whatever created it. A trigger rather than an application command because nothing in the repo creates organisations — they arrive by script or by hand.';

-- ── Backfill ─────────────────────────────────────────────────────────────────────────
--
-- Idempotent, so it covers the organisations that predate the trigger and does nothing to
-- the ones already complete.

SELECT nzi_console.provision_organisation(organisation_id) FROM nzi_console.organisations;

COMMIT;
