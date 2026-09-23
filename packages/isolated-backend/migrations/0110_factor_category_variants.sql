-- 0110 The category-variant registry: how one physical factor serves several categories (NZC-145).
--
-- ## What a variant is
--
-- The same measured factor is used under more than one GHG Protocol category. A car's mobile-combustion
-- factor is the same kgCO2e per unit whether the journey is a company vehicle (Scope 1), an employee's
-- business travel (3.6) or their commute (3.7) — what differs is which category it is being reported
-- under, not the number.
--
-- So a variant is recorded as a **suffix on the factor id**: `<base>-b` is the business-travel variant of
-- `<base>`. All variants of a base carry the same `kgco2e_per_unit`; the suffix records the category, and
-- nothing else. A variant that had a different value would not be a variant, it would be a different
-- factor.
--
-- This table is the registry those suffixes are read from. Nothing that fans a factor out may carry its
-- own list: `-c` means employee commuting because this table says so, in one place.
--
-- ## Why the suffix is parsed against this table and never against a pattern
--
-- Every factor already seeded ends in something that *looks* like a suffix: `diesel-demo`, `freight-demo`,
-- `electricity-us-demo`, `lca-rpet-demo`. A parser that split on the last hyphen would read `diesel-demo`
-- as the base `diesel` with a `-demo` variant, invent a category for it, and group two unrelated factors
-- together. Only a suffix **in this registry** is a suffix; everything else is part of the base. That is
-- the whole reason the registry exists rather than a convention in a comment.
--
-- ## Estate-wide, like the other definition tier
--
-- `reference_categories` — the definitions — is estate-wide with no `organisation_id`, while
-- `reference_values` is per tenant. A suffix vocabulary belongs to the first tier: the GHG Protocol's
-- categories are the same for every client, and two tenants disagreeing about what `-c` means would make
-- a factor id mean two things.
--
-- **One consequence to state plainly**, because it is a widening: unlike `reference_categories`, this
-- table is writable by `nzi_console_app` — the registry is admin-managed and extensible, so adding a
-- variant is a command rather than a migration. That means a tenant-reachable write to estate-wide data.
-- It is governed by the `factor.manage` capability — Admin alone, checked by every one of the three
-- commands before they touch anything — audited like any other command, and constrained by the
-- trigger below; a new variant is additive and cannot change what an existing suffix means. The
-- alternative — a per-tenant registry — would let two tenants define `-c` differently, which is the
-- failure this tier exists to prevent.
--
-- ## A suffix code is permanent, in use or not
--
-- The brief asked for "permanent once in use". This is stricter: a `suffix_code` can never be changed or
-- removed at all. The reason is that "in use" cannot be answered honestly from here. Factors are
-- tenant-scoped with `FORCE ROW LEVEL SECURITY`; this registry is estate-wide. A trigger counting
-- in-use factors would see only the tenant whose context happened to be set, so a suffix in use by
-- another client would look unused and the guard would let it be repurposed — the precise silent
-- re-categorisation of historical rows the rule exists to prevent.
--
-- Answering it properly would need a `SECURITY DEFINER` cross-tenant read (NZC-123), which is a privilege
-- granted to enforce a convenience. Making the code immutable needs no privilege at all, and the cost is
-- one retired row when somebody mistypes a suffix before anyone uses it.
--
-- Label, description and status stay editable, which is what refining a label and retiring a variant need.
--
-- ## Why a trigger rather than only a grant
--
-- `REVOKE DELETE` stops the application. It does not stop the owner, and the owner is who applies
-- migrations and who the test harness connects as — so a grant-only guard is one that cannot be
-- demonstrated to work. The trigger holds for every identity, which is also what makes it testable.

BEGIN;

CREATE TABLE nzi_console.factor_category_variants (
  -- The suffix as it appears on a factor id, leading hyphen included, so a reader never has to remember
  -- whether the stored form carries it.
  suffix_code text PRIMARY KEY
    CONSTRAINT factor_category_variant_suffix_shape CHECK (suffix_code ~ '^-[a-z]{1,4}$'),

  /** What the category is called when somebody is shown it. Refinable. */
  label text NOT NULL CHECK (btrim(label) <> ''),
  /** The GHG Protocol category this variant reports under — '3.6', '3.7', and so on. */
  ghg_category text NOT NULL CHECK (btrim(ghg_category) <> ''),
  description text NOT NULL DEFAULT '',

  -- Retired keeps the variant readable for history and withholds it from new fan-outs. There is no
  -- deleted state, here or anywhere else in this schema.
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  retired_at timestamptz,
  retired_by text,
  CONSTRAINT factor_category_variant_retired_shape
    CHECK ((status = 'retired') = (retired_at IS NOT NULL AND retired_by IS NOT NULL)),

  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source text NOT NULL DEFAULT 'migration' CHECK (source IN ('migration', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL
);

COMMENT ON TABLE nzi_console.factor_category_variants IS
  'The suffixes that record which GHG Protocol category a factor is being used under. All variants of a base factor share the same kgCO2e per unit — the suffix records the category, never a different value. Estate-wide, because the vocabulary is the same for every client and a factor id must not mean two things. Everything that fans a factor out reads this table; a suffix is a suffix only because it is in here, which is what stops `diesel-demo` being read as a variant of `diesel`.';

COMMENT ON COLUMN nzi_console.factor_category_variants.suffix_code IS
  'Permanent. Never renamed and never removed, whether in use or not: "in use" cannot be answered honestly from an estate-wide table when factors are tenant-scoped under forced RLS, and answering it would need a cross-tenant definer read. Retire the variant instead.';

-- ── The current vocabulary ───────────────────────────────────────────────────────────
INSERT INTO nzi_console.factor_category_variants
  (suffix_code, label, ghg_category, description, sort_order, created_by, updated_by)
VALUES
  ('-c', 'Commuting', '3.7',
   'The same factor used for an employee travelling to and from work.', 10, 'migration:0110', 'migration:0110'),
  ('-b', 'Business travel', '3.6',
   'The same factor used for a journey made for work that is not a commute.', 20, 'migration:0110', 'migration:0110'),
  ('-p', 'Purchased goods & services', '3.1',
   'The same factor used for a good or service bought by the organisation.', 30, 'migration:0110', 'migration:0110'),
  ('-u', 'Upstream transport & distribution', '3.4',
   'The same factor used for moving goods into or within the organisation.', 40, 'migration:0110', 'migration:0110'),
  ('-d', 'Downstream transport & distribution', '3.9',
   'The same factor used for moving sold goods onward to a customer.', 50, 'migration:0110', 'migration:0110'),
  ('-w', 'Waste', '3.5',
   'The same factor used for waste generated in operations.', 60, 'migration:0110', 'migration:0110');

-- ── The permanence guard ─────────────────────────────────────────────────────────────
CREATE FUNCTION nzi_console.factor_category_variant_is_permanent()
RETURNS trigger
LANGUAGE plpgsql SET search_path = nzi_console, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'A category variant is never deleted: % is permanent, because a factor id that used it is a historical record. Retire it instead.',
      OLD.suffix_code USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.suffix_code IS DISTINCT FROM OLD.suffix_code THEN
    RAISE EXCEPTION
      'A category variant is never renamed: % would silently re-categorise every factor already carrying it. Retire it and add the replacement.',
      OLD.suffix_code USING ERRCODE = 'raise_exception';
  END IF;

  -- The GHG category is what the suffix *means*; changing it is a rename by another route.
  IF NEW.ghg_category IS DISTINCT FROM OLD.ghg_category THEN
    RAISE EXCEPTION
      'A category variant keeps its GHG category: % means %, and changing that re-categorises every factor carrying it. Retire it and add the replacement.',
      OLD.suffix_code, OLD.ghg_category USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER factor_category_variant_is_permanent
  BEFORE UPDATE OR DELETE ON nzi_console.factor_category_variants
  FOR EACH ROW EXECUTE FUNCTION nzi_console.factor_category_variant_is_permanent();

COMMENT ON FUNCTION nzi_console.factor_category_variant_is_permanent() IS
  'Refuses to rename or remove a suffix code or its GHG category, for every identity rather than only the application role — a guard that only a grant enforces is one the owner walks past, and the owner is who applies migrations and who the test harness connects as.';

-- ── Grants ───────────────────────────────────────────────────────────────────────────
--
-- Writable by the application, unlike `reference_categories`, because the registry is admin-managed and
-- extensible: adding a variant is a governed command, not a migration. DELETE is revoked and the trigger
-- refuses it anyway.
GRANT SELECT, INSERT, UPDATE ON nzi_console.factor_category_variants TO nzi_console_app;
GRANT SELECT ON nzi_console.factor_category_variants TO nzi_console_worker;
REVOKE DELETE ON nzi_console.factor_category_variants
  FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

COMMIT;
