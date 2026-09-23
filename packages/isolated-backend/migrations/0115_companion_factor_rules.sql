-- 0115 One entry can resolve to more than one row (NZC-154).
--
-- Every mapping kind so far answers "which factor is this entry?" — one entry, one row. Some entries are
-- not one row. Electricity bought from the grid is a Scope 2 figure **and** the transmission and
-- distribution lost carrying it, which is Scope 3.3 and belongs to a different factor. A waste stream is
-- an entry and a treatment per material.
--
-- So a category may declare **companions**: additional rows the engine proposes alongside the resolved
-- primary. A companion is not another way to choose the primary factor — the rules in 0112/0113 do that,
-- first match wins — it is another row, and **every companion whose condition holds fires**, because two
-- companions are not competing answers to one question.
--
-- ## The transmission-and-distribution rule, and the correction in it
--
-- T&D applies to electricity that **travelled the grid to get here**, and that includes grid-supplied
-- renewables: a green tariff and a REGO certificate change what the supply is accounted as, not the wires
-- it arrived on. It does **not** apply to electricity generated and consumed on site, which crossed no
-- network and lost nothing in transmission.
--
-- That distinction cannot be read from the category. The spec carries both `2.purchased-electricity` and
-- `2.renewable-electricity`, and neither name settles it: renewable electricity may be a REGO-backed grid
-- tariff, which loses in transmission, or roof-mounted solar, which does not. So the condition reads a
-- captured field, and the same rule is declared on both categories.
--
-- ## Enumerated positively, which is the whole guard
--
-- `when_values` lists the supply kinds that **do** fire the companion. Written the other way — "everything
-- except self-generated" — a supply kind added later would start claiming transmission losses the day it
-- was introduced, silently and for every entry. Enumerating means a new kind fires nothing until somebody
-- decides it should, which is the same reason 0110 refuses a suffix nobody registered.
--
-- ## Additive, like every other kind
--
-- A category with no companion rules produces one row, exactly as today. A companion whose factor the
-- selected dataset does not carry declines and says so; it never fails the entry, and it never silently
-- becomes part of the primary.

BEGIN;

CREATE TABLE nzi_console.input_spec_companion_rules (
  category_code text NOT NULL REFERENCES nzi_console.input_spec_categories(category_code),
  companion_key text NOT NULL CHECK (btrim(companion_key) <> ''),
  ordering integer NOT NULL,

  -- What kind of companion this is. Enumerated rather than free text so a reader of a row knows what the
  -- engine thinks it is proposing, and so a report can group them.
  companion_kind text NOT NULL CHECK (companion_kind IN ('transmission-distribution', 'end-of-life')),

  -- The companion's own factor, and the GHG category the companion row is filed under — which is not the
  -- primary's. T&D on a Scope 2 purchase is Scope 3.3; end-of-life treatment is 3.12.
  factor_base text NOT NULL CHECK (btrim(factor_base) <> ''),
  ghg_category text NOT NULL CHECK (btrim(ghg_category) <> ''),

  -- The condition: which captured field, and which of its values make this companion apply. Positively
  -- enumerated, never negated — see the note above.
  when_field_key text NOT NULL CHECK (btrim(when_field_key) <> ''),
  -- `array_position(..., NULL) IS NULL` rather than `NOT (NULL = ANY (...))`, which is the footgun this
  -- schema has now been bitten by three times: `NULL = ANY (array)` is NULL, `NOT NULL` is NULL, and the
  -- row is admitted. `array_position` is the form that actually finds a NULL element (NZC-143, 151, 152).
  when_values text[] NOT NULL
    CHECK (cardinality(when_values) > 0
           AND NOT ('' = ANY (when_values))
           AND array_position(when_values, NULL) IS NULL),

  -- What the proposed row is called when a person sees it.
  label text NOT NULL CHECK (btrim(label) <> ''),
  note text NOT NULL DEFAULT '',

  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source text NOT NULL DEFAULT 'migration' CHECK (source IN ('migration', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,

  PRIMARY KEY (category_code, companion_key)
);

CREATE INDEX input_spec_companion_rules_order_idx
  ON nzi_console.input_spec_companion_rules (category_code, ordering)
  WHERE active;

GRANT SELECT ON nzi_console.input_spec_companion_rules TO nzi_console_app;
REVOKE INSERT, UPDATE, DELETE ON nzi_console.input_spec_companion_rules
  FROM nzi_console_app, nzi_console_worker, nzi_console_auth, PUBLIC;

COMMENT ON TABLE nzi_console.input_spec_companion_rules IS
  'Additional rows a category proposes alongside its resolved primary — transmission and distribution losses, end-of-life treatment (NZC-154). Every companion whose condition holds fires; they are not competing answers. Estate-wide and read-only to the application, like the rest of the input spec.';
COMMENT ON COLUMN nzi_console.input_spec_companion_rules.when_values IS
  'The values that DO fire this companion, enumerated. Never a negation: "everything except self-generated" would make a supply kind added later claim transmission losses from the day it was introduced.';

-- ── The field the condition reads is NOT added here ─────────────────────────────────────────────────
--
-- `supplySource` is a forward reference: the rule below names the field it needs, and the field itself
-- belongs to per-category spec authoring, which is its own phase.
--
-- The first draft of this migration did add it, to both electricity categories. That broke
-- `inputSpecReproducesGolden` — the characterisation pinning that the governed spec renders exactly what
-- the hand-written model rendered (NZC-102) — because a new field is, correctly, a change to what the
-- capture form shows. Re-pinning the golden model to accommodate this migration would have been
-- weakening a characterisation test to make a change pass, which is the one thing it exists to prevent.
--
-- So the rule waits on its field. Until then the companion declines with "supplySource has not been
-- captured", which is the additive behaviour and is asserted; nothing silently assumes grid.

-- ── Transmission and distribution ───────────────────────────────────────────────────────────────────
INSERT INTO nzi_console.input_spec_companion_rules
  (category_code, companion_key, ordering, companion_kind, factor_base, ghg_category,
   when_field_key, when_values, label, note, created_by, updated_by)
VALUES
  ('2.purchased-electricity', 'grid-td', 10, 'transmission-distribution', 'electricity-td-demo', '3.3',
   'supplySource', ARRAY['grid', 'grid-renewable', 'green-tariff', 'rego'],
   'Transmission & distribution losses',
   'Fires for any supply that reached the site over the network, which includes green tariffs and REGO-backed supply: the certificate changes what the supply is accounted as, not the wires it arrived on. Self-generated electricity is absent from the list rather than excluded by it.',
   'migration:0115', 'migration:0115');

-- **`2.renewable-electricity` deliberately has none yet**, though the same losses apply to it.
--
-- A companion is proposed only alongside a resolved primary — transmission losses attributed to a supply
-- the system could not identify would be a number with no parent. That category has no primary factor
-- rule, so a companion declared on it could never fire, and seeding one would be declaring something
-- dead. It waits on the category's own mapping, which carries a question nobody has ruled on: whether a
-- REGO-backed supply's *location-based* figure uses the grid average factor, as the accounting convention
-- suggests it should.
--
-- The REGO case is not untested for that reason — `supplySource = 'rego'` on a purchased-electricity
-- entry fires the companion, which is the axis that matters: what fires it is how the electricity
-- arrived, never which category it was filed under.

COMMIT;
