-- 0113 A rule whose basis comes from an external lookup (NZC-151).
--
-- The fourth mapping kind, and the first whose input is not something the consultant typed. A vehicle
-- registration is entered, a lookup returns what that vehicle *is* — make, fuel, class — and those
-- attributes select the factor. The plate is the key to the lookup and nothing else.
--
-- **This makes an existing behaviour declared rather than guessed.** `resolveVehicleFactor` already
-- turns a looked-up vehicle into a factor, by `ILIKE`-matching a fuel keyword and a class term against
-- factor *labels*. That works until a library renames a factor, and it cannot be reviewed: the mapping
-- lives in a pattern rather than in a row anybody can read. Same lookup, same derivations — the choice
-- of factor moves into the spec.
--
-- **The plate stops at the lookup boundary, and this migration does not move it** (NZC-103). No column
-- here holds a registration. `enrichment_key_field` names the *field* the plate is typed into, so the
-- resolver knows which value to hand the lookup; the value itself is transient, never written, and the
-- resolver is given attributes rather than a registration so nothing database-facing has one to
-- mishandle.
--
-- **Additive, like the three kinds before it.** A category with no rules still falls through to the free
-- search, and an enriched rule that cannot resolve — no plate typed, no lookup performed, the lookup
-- returned nothing, or the attribute does not match — declines rather than failing the entry.

BEGIN;

ALTER TABLE nzi_console.input_spec_factor_rules
  -- Which lookup supplies the attributes. A column rather than an assumption, because business travel
  -- and commuting will reuse this table with the same provider and a category of their own, and a later
  -- provider must not have to pretend to be this one.
  ADD COLUMN enrichment_source text,
  -- The entry field holding the lookup key — `registrationFinder` for a vehicle. The key's *value* is
  -- never stored: this names where to find it, not what it was.
  ADD COLUMN enrichment_key_field text;

-- `enriched` joins the three kinds. Dropped and re-added rather than edited, because a CHECK is not
-- editable in place; 0112 stays exactly as it was applied.
ALTER TABLE nzi_console.input_spec_factor_rules
  DROP CONSTRAINT input_spec_factor_rules_rule_kind_check;

ALTER TABLE nzi_console.input_spec_factor_rules
  ADD CONSTRAINT input_spec_factor_rules_rule_kind_check
    CHECK (rule_kind IN ('lookup', 'basis-branch', 'suffix-variant', 'enriched'));

ALTER TABLE nzi_console.input_spec_factor_rules
  DROP CONSTRAINT input_spec_factor_rules_shape;

-- Every branch still names every column it requires to be NULL, for the reason 0112 gives: written the
-- shorter way a CHECK is satisfied by NULL and admits the rows it was written to exclude.
--
-- `enriched` reuses `basis_field_key` / `basis_value` deliberately. The role is identical to a
-- basis-branch — a named thing takes a value, and that selects this rule — and only the provenance
-- differs: a basis-branch reads the entry, an enriched rule reads what the lookup returned. Two more
-- columns meaning the same thing would be two places for the resolver to disagree with itself.
ALTER TABLE nzi_console.input_spec_factor_rules
  ADD CONSTRAINT input_spec_factor_rules_shape CHECK (
    (rule_kind = 'lookup'
      AND basis_field_key IS NULL AND basis_value IS NULL AND suffix_code IS NULL
      AND enrichment_source IS NULL AND enrichment_key_field IS NULL)
    OR (rule_kind = 'basis-branch'
      AND basis_field_key IS NOT NULL AND btrim(basis_field_key) <> ''
      AND basis_value IS NOT NULL AND btrim(basis_value) <> ''
      AND suffix_code IS NULL
      AND enrichment_source IS NULL AND enrichment_key_field IS NULL)
    OR (rule_kind = 'suffix-variant'
      AND suffix_code IS NOT NULL
      AND basis_field_key IS NULL AND basis_value IS NULL
      AND enrichment_source IS NULL AND enrichment_key_field IS NULL)
    OR (rule_kind = 'enriched'
      AND enrichment_source IS NOT NULL AND btrim(enrichment_source) <> ''
      AND enrichment_key_field IS NOT NULL AND btrim(enrichment_key_field) <> ''
      AND basis_field_key IS NOT NULL AND btrim(basis_field_key) <> ''
      AND basis_value IS NOT NULL AND btrim(basis_value) <> ''
      AND suffix_code IS NULL)
  );

-- 0112's uniqueness stopped two branches of one field claiming the same value. An enriched rule takes a
-- basis from somewhere else, so `fuel = diesel` from the DVLA and `unit = litres` from the entry are
-- different claims that must both be allowed — while two enriched rules both claiming `fuel = diesel`
-- are still the coin toss that constraint exists to prevent.
ALTER TABLE nzi_console.input_spec_factor_rules
  DROP CONSTRAINT input_spec_factor_rules_one_branch_per_value;

-- `NULLS NOT DISTINCT` is load-bearing and was missing from the first version of this migration.
-- A plain UNIQUE treats every NULL as different, so adding `enrichment_source` to the key — NULL on
-- every non-enriched rule — quietly stopped it refusing two basis-branches claiming the same value,
-- which is precisely what 0112 added it for. 0112's own test caught the regression.
ALTER TABLE nzi_console.input_spec_factor_rules
  ADD CONSTRAINT input_spec_factor_rules_one_branch_per_value
    UNIQUE NULLS NOT DISTINCT (category_code, enrichment_source, basis_field_key, basis_value);

COMMENT ON COLUMN nzi_console.input_spec_factor_rules.enrichment_source IS
  'Which external lookup supplies the attributes for an `enriched` rule (currently only the DVLA vehicle enquiry). Never a credential and never a URL — the provider is resolved in code (NZC-151).';
COMMENT ON COLUMN nzi_console.input_spec_factor_rules.enrichment_key_field IS
  'The entry field whose value is handed to the lookup — a vehicle registration for the DVLA. The value is transient: it is never stored here or anywhere else, and the resolver receives attributes rather than the key (NZC-103).';

-- ── Company vehicles, resolved from what the vehicle actually is ────────────────────────────────────
--
-- Ordered ahead of the `unit` basis-branch 0112 seeded, because a lookup that knows the vehicle is a
-- better answer than an inference from the unit it was measured in.
--
-- Only diesel is seeded, and only because `diesel-demo` exists. A petrol or electric rule would name a
-- factor the demonstration dataset does not carry — it would decline safely, but it would also be this
-- migration asserting a mapping nobody has agreed, which is the habit the declarative spec exists to
-- end.
INSERT INTO nzi_console.input_spec_factor_rules
  (category_code, rule_key, ordering, rule_kind, factor_base,
   enrichment_source, enrichment_key_field, basis_field_key, basis_value,
   note, created_by, updated_by)
VALUES
  ('1.company-vehicles', 'dvla-diesel', 5, 'enriched', 'diesel-demo',
   'dvla', 'registrationFinder', 'fuel', 'diesel',
   'A vehicle the DVLA reports as diesel. The fuel keyword is derived by the same function the lookup flow already uses, so the spec and the lookup cannot disagree about what "diesel" means.',
   'migration:0113', 'migration:0113');

COMMIT;
