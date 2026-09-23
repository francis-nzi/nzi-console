-- 0116 A category can reuse another category's flow and file the result under its own (NZC-158).
--
-- Business travel by road and commuting by car ask the same question company vehicles asks: what is this
-- vehicle, and which factor prices it. The answer differs only in **which GHG category the result is filed
-- under** — 3.6 for a journey made for work, 3.7 for the journey to work — and that is precisely what the
-- variant registry (0110) exists to express.
--
-- So those categories declare a **sub-flow**: run another category's rules, take what they resolve, and
-- apply this category's registered suffix to it. The DVLA lookup, the fuel and class derivations and the
-- vehicle rules are **referenced, not copied**. A change to how a vehicle is identified reaches all three
-- consumers because there is one flow, not three transcriptions of it that drift apart.
--
-- ## The leak this is shaped around
--
-- There are two ways a Scope 1 vehicle factor reaches business travel. The obvious one is resolving the
-- base directly. The other — the one worth building the primitive around — is composing the variant,
-- finding it missing, and using the base because it is *nearly* right.
--
-- That second path is this layer's version of "silence means yes". A commute priced with the company's
-- Scope 1 diesel factor is a plausible number filed under the wrong scope, and nothing about it looks
-- wrong. So an unresolvable variant **stops** (NZC-151): the entry goes to the search for a person to
-- settle, and never to the base. Missing from the registry and missing from the dataset both stop; the
-- reason differs, the refusal does not.
--
-- ## Composition is the registry's, not the string's
--
-- The suffix is applied through the registry parser — `diesel-demo` plus `-b` is `diesel-demo-b`. A base
-- may itself be hyphenated, which is exactly why splitting on the last hyphen is wrong: it would read
-- `diesel-demo` as `diesel` with a `-demo` variant and compose something nobody registered (NZC-145).
-- The unit is the base's, unchanged, per NZC-146 — a variant is the same measured factor filed
-- differently, so a composed variant that changed unit would be a different factor wearing the name.

BEGIN;

ALTER TABLE nzi_console.input_spec_factor_rules
  -- Which category's flow to run. A reference rather than a copy, and a foreign key so it cannot name a
  -- category that does not exist.
  ADD COLUMN sub_flow_category text REFERENCES nzi_console.input_spec_categories(category_code);

-- A sub-flow has no factor base of its own: the base is whatever the referenced flow resolves. The column
-- stops being universally required and becomes required per kind, which the shape constraint enforces.
ALTER TABLE nzi_console.input_spec_factor_rules
  ALTER COLUMN factor_base DROP NOT NULL;

ALTER TABLE nzi_console.input_spec_factor_rules
  DROP CONSTRAINT input_spec_factor_rules_rule_kind_check;

ALTER TABLE nzi_console.input_spec_factor_rules
  ADD CONSTRAINT input_spec_factor_rules_rule_kind_check
    CHECK (rule_kind IN ('lookup', 'basis-branch', 'suffix-variant', 'enriched', 'sub-flow'));

ALTER TABLE nzi_console.input_spec_factor_rules
  DROP CONSTRAINT input_spec_factor_rules_shape;

-- Every branch still names every column it requires to be NULL, including the two this migration adds.
-- The reason is unchanged and has now bitten four times: a CHECK is satisfied by NULL, so a branch that
-- omits a column says nothing about it (NZC-143, 149, 152, 154).
ALTER TABLE nzi_console.input_spec_factor_rules
  ADD CONSTRAINT input_spec_factor_rules_shape CHECK (
    (rule_kind = 'lookup'
      AND factor_base IS NOT NULL AND btrim(factor_base) <> ''
      AND basis_field_key IS NULL AND basis_value IS NULL AND suffix_code IS NULL
      AND enrichment_source IS NULL AND enrichment_key_field IS NULL AND sub_flow_category IS NULL)
    OR (rule_kind = 'basis-branch'
      AND factor_base IS NOT NULL AND btrim(factor_base) <> ''
      AND basis_field_key IS NOT NULL AND btrim(basis_field_key) <> ''
      AND basis_value IS NOT NULL AND btrim(basis_value) <> ''
      AND suffix_code IS NULL
      AND enrichment_source IS NULL AND enrichment_key_field IS NULL AND sub_flow_category IS NULL)
    OR (rule_kind = 'suffix-variant'
      AND factor_base IS NOT NULL AND btrim(factor_base) <> ''
      AND suffix_code IS NOT NULL
      AND basis_field_key IS NULL AND basis_value IS NULL
      AND enrichment_source IS NULL AND enrichment_key_field IS NULL AND sub_flow_category IS NULL)
    OR (rule_kind = 'enriched'
      AND factor_base IS NOT NULL AND btrim(factor_base) <> ''
      AND enrichment_source IS NOT NULL AND btrim(enrichment_source) <> ''
      AND enrichment_key_field IS NOT NULL AND btrim(enrichment_key_field) <> ''
      AND basis_field_key IS NOT NULL AND btrim(basis_field_key) <> ''
      AND basis_value IS NOT NULL AND btrim(basis_value) <> ''
      AND suffix_code IS NULL AND sub_flow_category IS NULL)
    -- A sub-flow carries the two things it needs and nothing else: whose flow to run, and which suffix to
    -- file the answer under. `factor_base` must be NULL — a sub-flow that also named a base would be
    -- declaring two answers, and which one won would be an implementation detail.
    OR (rule_kind = 'sub-flow'
      AND sub_flow_category IS NOT NULL AND btrim(sub_flow_category) <> ''
      AND suffix_code IS NOT NULL
      AND factor_base IS NULL
      AND basis_field_key IS NULL AND basis_value IS NULL
      AND enrichment_source IS NULL AND enrichment_key_field IS NULL)
  );

-- A category reusing its own flow is a loop with no answer. The resolver refuses cycles of any length,
-- because it must — this only stops the shortest one, at the point it is written rather than run.
ALTER TABLE nzi_console.input_spec_factor_rules
  ADD CONSTRAINT input_spec_factor_rules_no_self_reference
    CHECK (sub_flow_category IS NULL OR sub_flow_category <> category_code);

-- ── Uniqueness applies to rules that have a basis, and only to those ────────────────────────────────
--
-- 0113 made this key `NULLS NOT DISTINCT`, correctly: a plain UNIQUE treats every NULL as different, so
-- adding `enrichment_source` to the key quietly stopped it refusing two branches claiming the same value.
--
-- It over-tightened in the other direction, which this migration is what exposes. A rule with **no** basis
-- — `lookup`, `suffix-variant`, and now `sub-flow` — keys as `(category, NULL, NULL, NULL)`, and under
-- `NULLS NOT DISTINCT` a category may hold exactly one of those. That forbids the ordinary additive shape:
-- a sub-flow with a plain lookup behind it, or two lookups at different orderings, which the resolver
-- supports and first-match-wins exists for.
--
-- So the rule becomes what it always meant: **two branches of the same field may not claim the same
-- value**. A partial index says that precisely — rows without a basis are not in it at all — while
-- `NULLS NOT DISTINCT` keeps 0113's fix for the rows that are, so a captured basis and a DVLA basis on the
-- same field and value still collide.
ALTER TABLE nzi_console.input_spec_factor_rules
  DROP CONSTRAINT input_spec_factor_rules_one_branch_per_value;

CREATE UNIQUE INDEX input_spec_factor_rules_one_branch_per_value
  ON nzi_console.input_spec_factor_rules (category_code, enrichment_source, basis_field_key, basis_value)
  NULLS NOT DISTINCT
  WHERE basis_field_key IS NOT NULL;

COMMENT ON COLUMN nzi_console.input_spec_factor_rules.sub_flow_category IS
  'The category whose rules this one reuses (NZC-158). A reference, never a copy: one vehicle flow serves company vehicles, business-travel road and commuting, so a change to how a vehicle is identified reaches all three.';

-- ── Business travel by road, and commuting by car ───────────────────────────────────────────────────
--
-- Both run the company-vehicle flow — the DVLA lookup and the fuel branch — and file the result under
-- their own category through the registry: `-b` is 3.6, `-c` is 3.7.
INSERT INTO nzi_console.input_spec_factor_rules
  (category_code, rule_key, ordering, rule_kind, sub_flow_category, suffix_code, note, created_by, updated_by)
VALUES
  ('3.6', 'road-via-vehicle-flow', 10, 'sub-flow', '1.company-vehicles', '-b',
   'A car driven for work is identified exactly as a company vehicle is; only the category differs. Reusing the flow rather than restating it means the DVLA derivations have one definition.',
   'migration:0116', 'migration:0116'),
  ('3.7', 'car-via-vehicle-flow', 10, 'sub-flow', '1.company-vehicles', '-c',
   'The same flow again for the journey to work. `-c` files it under 3.7, which is the only difference between this and the row above.',
   'migration:0116', 'migration:0116');

COMMIT;
