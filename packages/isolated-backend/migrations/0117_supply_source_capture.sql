-- 0117 Electricity records how it arrived, and renewable electricity gets its primary mapping (NZC-159).
--
-- Per-category spec authoring, and the first of it. Two things land together because neither is useful
-- alone: the field that says how the electricity reached the site, and the mapping that says which factor
-- prices it.
--
-- ## `supplySource`, the field NZC-154 declared a rule against and could not yet collect
--
-- The transmission-and-distribution companion fires on supply that crossed a network — grid, and equally a
-- green tariff or REGO-backed supply, because a certificate changes what the electricity is accounted as
-- and not the wires it arrived on. It does not fire on generation consumed where it was produced.
--
-- 0115 declared that rule against a field that did not exist, deliberately: adding a capture field is a
-- change to what the form shows, and slipping it inside a migration about companions would have moved the
-- render characterisation to make that migration pass. This is the change where moving it is the point.
--
-- ## `2.renewable-electricity` gets the same location factor as purchased electricity (NZC-157)
--
-- Under the location-based method contractual instruments are irrelevant: the figure is the grid average
-- for the grid and region whatever the supply contract says. The renewable-ness lives entirely in the
-- market-based row, which sits out of the headline and carries `show_in_report` (NZC-143/144).
--
-- So the two categories resolve to the same factor, and that is not an oversight to be tidied later. A
-- future reader finding `electricity-demo` under "Renewable Electricity" should find this paragraph rather
-- than assume a copy-paste error.
--
-- With a primary in place the category can carry its companion, which 0115 withheld because a companion is
-- proposed only alongside a resolved primary and one declared there could never have fired.
--
-- ## Still substrate
--
-- Nothing consumes the declarative resolver. This migration collects a field and declares rules; wiring
-- the write path to *resolve* through them is a separate change with its own gate.

BEGIN;

-- ── The captured value ──────────────────────────────────────────────────────────────────────────────
--
-- Enumerated positively, and the enumeration is the guard rather than a tidiness: a supply kind added
-- later must claim no transmission losses until somebody decides it should (NZC-154). `self-generated` is
-- a member here — it is a real answer to the question — and is simply absent from the companion's own
-- list, which is what makes it fire nothing.
--
-- `IS NULL OR` rather than relying on the comparison: a CHECK is satisfied by NULL, so a bare `IN` would
-- admit NULL by accident rather than by decision. Here it is by decision — an entry captured before the
-- question is answered is ordinary, and the companion declines while it is unanswered.
ALTER TABLE nzi_console.job_scope_rows
  ADD COLUMN supply_source text
    CHECK (supply_source IS NULL OR supply_source IN
      ('grid', 'grid-renewable', 'green-tariff', 'rego', 'self-generated'));

COMMENT ON COLUMN nzi_console.job_scope_rows.supply_source IS
  'How purchased electricity reached the site (NZC-159). Grid supply — including green tariffs and REGO-backed supply — carries transmission and distribution losses; generation consumed where it was produced does not. NULL until answered, and the companion declines while it is.';

-- ── The field, on both electricity categories ───────────────────────────────────────────────────────
--
-- Identical in shape to the entry in `inputSpec.seed.json`, because the fixture and this migration are two
-- representations of one spec and the render characterisation is what proves they agree.
--
-- Unconstrained by audience, mode or lean. The client is asked because the site knows how its electricity
-- arrives and the consultant often does not; lean capture keeps it because it decides whether a Scope 3 row
-- exists at all, so dropping it under lean would lose a row silently rather than collect less detail.
INSERT INTO nzi_console.input_spec_fields
  (category_code, field_key, ordering, control, label, hint, optional, created_by, updated_by)
VALUES
  ('2.purchased-electricity', 'supplySource', 25, 'select', 'Supply',
   'How the electricity reached this site. Grid supply — including a green tariff or REGO-backed supply — carries transmission and distribution losses; electricity generated and used on site does not.',
   false, 'migration:0117', 'migration:0117'),
  ('2.renewable-electricity', 'supplySource', 25, 'select', 'Supply',
   'A REGO-backed or green-tariff supply still arrives over the grid and carries its losses. Generation used on the site that produced it does not.',
   false, 'migration:0117', 'migration:0117');

-- ── Renewable electricity resolves to the grid average, and carries the same companion ──────────────
INSERT INTO nzi_console.input_spec_factor_rules
  (category_code, rule_key, ordering, rule_kind, factor_base, note, created_by, updated_by)
VALUES
  ('2.renewable-electricity', 'grid-electricity', 10, 'lookup', 'electricity-demo',
   'The same location-based grid factor as purchased electricity, which is the accounting answer rather than a copy-paste: under the location-based method a REGO or green tariff does not change the figure (NZC-157). The instrument is reported as a separate market row, out of the headline.',
   'migration:0117', 'migration:0117');

INSERT INTO nzi_console.input_spec_companion_rules
  (category_code, companion_key, ordering, companion_kind, factor_base, ghg_category,
   when_field_key, when_values, label, note, created_by, updated_by)
VALUES
  ('2.renewable-electricity', 'grid-td', 10, 'transmission-distribution', 'electricity-td-demo', '3.3',
   'supplySource', ARRAY['grid', 'grid-renewable', 'green-tariff', 'rego'],
   'Transmission & distribution losses',
   'Withheld by 0115 because this category had no primary rule and a companion is proposed only alongside one — it could never have fired. The primary above is what makes it live.',
   'migration:0117', 'migration:0117');

COMMIT;
