-- 0112 A capture category declares how it reaches a factor (NZC-149).
--
-- Until now the mapping from "what the consultant is recording" to "which factor calculates it" lived in
-- a smart search: a list of everything the selected dataset offers, with the category as advice. That
-- works, and it is also why two people capturing the same thing can land on two different factors.
--
-- So the mapping becomes data, beside the rest of the input spec (0093) rather than in a switch
-- statement. Three kinds cover what the live platform actually does:
--
--   lookup          this category always uses this factor
--   basis-branch    the factor depends on what was captured — a vehicle in litres is a fuel
--                   calculation, the same vehicle in kilometres is a distance calculation, and those
--                   are different factors rather than a conversion of one another
--   suffix-variant  the factor is a registered category variant of a base (0110 / NZC-145): the same
--                   measured factor, filed under the GHG category the suffix names
--
-- **Additive, and it has to stay that way.** A category with no rules behaves exactly as it does today,
-- and a rule naming a factor the selected dataset does not carry declines rather than failing the entry.
-- A consultant who cannot record a number because the taxonomy is incomplete records it somewhere that
-- is not this system, so declining to the existing search is the behaviour. What must not happen is
-- declining quietly — the resolver returns every rule it considered and why each one passed.
--
-- **Estate-wide, like the spec it extends.** `input_spec_categories` has no `organisation_id` because
-- the GHG taxonomy is the same for everyone, and so is the question of which factor a category means.
-- Same posture on writes: the application reads and never writes. A change is a migration, or a future
-- admin command carrying its own capability and its own audit event.

BEGIN;

CREATE TABLE nzi_console.input_spec_factor_rules (
  category_code text NOT NULL REFERENCES nzi_console.input_spec_categories(category_code),
  -- Stable within the category, so a rule can be referred to in an audit trail or a bug report.
  rule_key text NOT NULL CHECK (btrim(rule_key) <> ''),
  -- First match wins. Ties break on rule_key so the order is total and does not depend on the plan.
  ordering integer NOT NULL,
  rule_kind text NOT NULL CHECK (rule_kind IN ('lookup', 'basis-branch', 'suffix-variant')),

  -- The factor id without a category suffix. Every kind needs one: `suffix-variant` builds on it,
  -- the other two use it as-is.
  factor_base text NOT NULL CHECK (btrim(factor_base) <> ''),

  -- basis-branch only: the captured field whose value selects this branch, and the value that does.
  basis_field_key text,
  basis_value text,

  -- suffix-variant only: which registered suffix to attach. The foreign key is the point — a rule
  -- cannot name a suffix nobody registered, which is the same guarantee 0110 gives factor ids.
  suffix_code text REFERENCES nzi_console.factor_category_variants(suffix_code),

  note text NOT NULL DEFAULT '',

  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source text NOT NULL DEFAULT 'migration' CHECK (source IN ('migration', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,

  PRIMARY KEY (category_code, rule_key),

  -- Each kind carries exactly the columns it means, and **every branch names every column** — including
  -- the ones it requires to be NULL.
  --
  -- Writing this as `rule_kind <> 'basis-branch' OR basis_field_key IS NOT NULL` would be the shape that
  -- has already been wrong here once: a CHECK is satisfied by NULL, so `false OR (NULL = 'x')` is NULL
  -- and passes. Enumerating each kind in full, with `IS NOT NULL` / `IS NULL` rather than equality
  -- against a nullable column, is a constraint that can actually refuse.
  CONSTRAINT input_spec_factor_rules_shape CHECK (
    (rule_kind = 'lookup'
      AND basis_field_key IS NULL AND basis_value IS NULL AND suffix_code IS NULL)
    OR (rule_kind = 'basis-branch'
      AND basis_field_key IS NOT NULL AND btrim(basis_field_key) <> ''
      AND basis_value IS NOT NULL AND btrim(basis_value) <> ''
      AND suffix_code IS NULL)
    OR (rule_kind = 'suffix-variant'
      AND suffix_code IS NOT NULL
      AND basis_field_key IS NULL AND basis_value IS NULL)
  ),

  -- Two branches of the same field cannot claim the same value: the winner would be whichever row the
  -- ordering happened to put first, which is a coin toss wearing a rule's clothing.
  CONSTRAINT input_spec_factor_rules_one_branch_per_value
    UNIQUE (category_code, basis_field_key, basis_value)
);

-- Read whenever a capture form resolves a factor, in evaluation order.
CREATE INDEX input_spec_factor_rules_order_idx
  ON nzi_console.input_spec_factor_rules (category_code, ordering)
  WHERE active;

GRANT SELECT ON nzi_console.input_spec_factor_rules TO nzi_console_app;
REVOKE INSERT, UPDATE, DELETE ON nzi_console.input_spec_factor_rules
  FROM nzi_console_app, nzi_console_worker, nzi_console_auth, PUBLIC;

COMMENT ON TABLE nzi_console.input_spec_factor_rules IS
  'How a capture category reaches a factor: lookup, basis-branch or suffix-variant (NZC-149). Estate-wide like the spec it extends. Additive — a category with no rules falls through to the free search, and so does a rule whose factor the selected dataset does not carry.';
COMMENT ON COLUMN nzi_console.input_spec_factor_rules.factor_base IS
  'The factor id without a category suffix. Bases are recovered by splitting on the registry (0110), never on the last hyphen: every seeded factor ends in "-demo", which a naive parser reads as a variant.';

-- ── The two exemplars, migrated on as the characterisation ──────────────────────────────────────────
--
-- Deliberately only two. These are the categories whose mapping is already settled; seeding a rule for a
-- category whose factor family nobody has agreed would be inventing domain policy in a migration, and the
-- whole point of making this declarative is that it stops being invented in passing.
--
-- Purchased electricity is the plain case: metered electricity is the grid factor, always.
INSERT INTO nzi_console.input_spec_factor_rules
  (category_code, rule_key, ordering, rule_kind, factor_base, note, created_by, updated_by)
VALUES
  ('2.purchased-electricity', 'grid-electricity', 10, 'lookup', 'electricity-demo',
   'Metered electricity resolves to the grid factor. A market-based instrument is a different row with its own method flag (NZC-143), not a different rule here.',
   'migration:0112', 'migration:0112');

-- Company vehicles is the case that needs the branch, and the basis is the unit — which is exactly the
-- distinction NZC-146 made checkable. Litres of diesel and kilometres travelled are not two spellings of
-- one quantity; they are two calculations, and the factor differs.
--
-- Only the fuel branch is seeded. There is no per-kilometre vehicle factor in the demonstration dataset,
-- so a distance branch would name a factor that does not exist — and while that declines safely rather
-- than breaking, seeding a rule that can never fire would be stating a mapping nobody has agreed. The
-- distance entry keeps the free search until there is a factor to point it at.
INSERT INTO nzi_console.input_spec_factor_rules
  (category_code, rule_key, ordering, rule_kind, factor_base, basis_field_key, basis_value, note,
   created_by, updated_by)
VALUES
  ('1.company-vehicles', 'fuel-litres', 10, 'basis-branch', 'diesel-demo', 'unit', 'litres',
   'A vehicle recorded in litres is a fuel calculation. Kilometres would be a distance calculation against a different factor; no such factor is in the demonstration dataset, so that entry still uses the search.',
   'migration:0112', 'migration:0112');

COMMIT;
