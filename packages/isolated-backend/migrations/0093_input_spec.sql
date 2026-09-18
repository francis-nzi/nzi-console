-- 0093 The per-category input spec becomes governed data (NZC-102).
--
-- What a consultant or a client is asked for when they record an emission — which fields, in which
-- order, with which controls, labels and hints, and which of them appear at all — lives in 488
-- lines of TypeScript that both surfaces already read. That model is correct; what it is not is
-- **governed**. It cannot be versioned, it carries no provenance, changing it is a deploy, and a
-- category cannot be retired without deleting code.
--
-- This is the schema it moves into. The renderer is unchanged in what it produces: the whole 160-
-- render matrix is pinned in `entryRenderMatrix.golden.json` and must be identical afterwards.
--
-- ## Not `reference_values`
--
-- `0089` chose a deliberately flat shape — "one optional column is cheaper than a jsonb blob nobody
-- can index". A field spec has an order, a control, reveal conditions and label variants; forcing
-- that through `code`/`source_ref` is exactly the blob that design refused. So: new tables.
--
-- The vocabulary still stays one. `input_spec_categories.reference_category_key` points at a
-- `reference_categories` row — `emission_category`, registered alongside industries and referrals —
-- so the emission taxonomy is declared as a governed vocabulary in the same registry as every
-- other, rather than being a private list this subsystem happens to hold.
--
-- ## Global, not per-organisation
--
-- Both tables are global and carry no `organisation_id`. The GHG Protocol taxonomy is the same for
-- every client of every firm, and a per-organisation copy would be 21 identical rows per tenant
-- that nobody edits, plus a tenant policy protecting nothing. They follow `reference_categories`:
-- readable by the application, writable only through a migration or a future governed admin
-- command with its own capability.
--
-- ## One row per category, not one row per kind
--
-- The fields are seeded **resolved per category** rather than kept generic by kind. A kind-generic
-- spec would mean editing Company Vehicles also edited Business Travel and Employee Commuting,
-- which is precisely wrong for what comes next: per-category specs from the diagrams, each edited
-- on its own. It costs ~200 rows and buys independence.
--
-- A consequence worth stating: because kind and spend are resolved at seed time, a field's
-- remaining conditions are audience, mode and lean. `label_variants` is keyed on all three — the
-- brief said audience and mode, and one field needs the third: under lean capture the factor field
-- changes its control (factor-select becomes factor-review) and its hint, because it stops being a
-- required pick and becomes a shown result. That is content, so it belongs in the data.
--
-- ## What stays in the interpreter, and why
--
-- **Templates.** A hint reading "Smart search — Scope 1 · Company Vehicles factors only" is the
-- category interpolated into a sentence. Storing 21 literal copies would duplicate the taxonomy
-- into the spec and let the two drift, so the row stores `{scopedTo}` and the interpreter
-- substitutes. Same for `{manualHint}`.
--
-- **Lean capture.** `lean` is `leanCapture AND audience = crm AND mode = new` — a guard computed
-- from three inputs, not a property of any field. The data says which fields survive it;
-- *deciding* it is code.

BEGIN;

-- The emission taxonomy, declared where every other governed vocabulary is declared.
INSERT INTO nzi_console.reference_categories (category_key, label, scope, description, carries_code, code_label) VALUES
  ('emission_category', 'Emission categories', 'shared',
   'The GHG Protocol scope and category taxonomy an emission entry is recorded against. Shared: the same for every organisation, and not firm-configurable.',
   true, 'Scope')
ON CONFLICT (category_key) DO NOTHING;

CREATE TABLE nzi_console.input_spec_categories (
  category_code text PRIMARY KEY,
  -- The link that keeps one vocabulary: these codes ARE the emission_category values.
  reference_category_key text NOT NULL REFERENCES nzi_console.reference_categories(category_key),
  scope text NOT NULL CHECK (scope IN ('1', '2', '3')),
  name text NOT NULL CHECK (btrim(name) <> ''),
  kind text NOT NULL CHECK (kind IN ('manual', 'spend', 'vehicle', 'travel', 'commuting', 'fugitive')),
  -- Ordered: the first entry is the unit offered by default, which differs by kind (GBP for spend,
  -- passenger.km for travel and commuting, kWh otherwise).
  units text[] NOT NULL CHECK (cardinality(units) > 0),
  manual_entry_hint text NOT NULL,
  -- Deactivate, never delete: a retired category must stay resolvable for every row that cites it.
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source text NOT NULL DEFAULT 'migration' CHECK (source IN ('migration', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL
);

CREATE TABLE nzi_console.input_spec_fields (
  category_code text NOT NULL REFERENCES nzi_console.input_spec_categories(category_code),
  field_key text NOT NULL,
  ordering integer NOT NULL,
  control text NOT NULL,
  -- May contain {scopedTo} or {manualHint}; the interpreter substitutes from the category.
  label text NOT NULL CHECK (btrim(label) <> ''),
  hint text,
  -- Nullable on purpose: NULL = the field says nothing, false = it says explicitly not optional.
  -- The hand-written model distinguished the two and the renders differ, so the spec must too.
  optional boolean,

  -- Reveal conditions. NULL means "no constraint on this axis", which is the common case — a
  -- nullable column rather than a catch-all row, so an unconstrained field says so by omission.
  when_audiences text[] CHECK (when_audiences IS NULL OR when_audiences <@ ARRAY['crm', 'portal']),
  when_modes text[] CHECK (when_modes IS NULL OR when_modes <@ ARRAY['new', 'existing']),
  -- true = only under lean capture; false = only when NOT lean; NULL = either.
  when_lean boolean,

  -- Per-render overrides of label, hint, control or optionality, keyed on audience, mode and lean.
  -- One row with explicit variants rather than near-duplicate rows differing in a single string.
  -- Shape: [{"audience":"portal","mode":"new","lean":false,"label":"Activity"}] — an axis the
  -- variant omits is one it does not constrain, and the most specific matching variant wins.
  label_variants jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(label_variants) = 'array'),

  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source text NOT NULL DEFAULT 'migration' CHECK (source IN ('migration', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,

  PRIMARY KEY (category_code, field_key)
);

-- Read in category order, then field order, on every render.
CREATE INDEX input_spec_fields_order_idx
  ON nzi_console.input_spec_fields (category_code, ordering)
  WHERE active;

-- The application reads the spec and never writes it: a change is a migration, or a future admin
-- command carrying its own capability and its own audit event. Same posture as
-- reference_categories (0089) — a governed vocabulary is not editable by the surface that consumes
-- it.
GRANT SELECT ON nzi_console.input_spec_categories, nzi_console.input_spec_fields TO nzi_console_app;
REVOKE INSERT, UPDATE, DELETE ON nzi_console.input_spec_categories, nzi_console.input_spec_fields
  FROM nzi_console_app, nzi_console_worker, nzi_console_auth, PUBLIC;

COMMENT ON TABLE nzi_console.input_spec_categories IS
  'Governed per-category input spec: scope, kind, ordered units and manual-entry hint (NZC-102). Global — the GHG taxonomy is the same for every organisation. Deactivate, never delete.';
COMMENT ON TABLE nzi_console.input_spec_fields IS
  'The fields of one category''s entry form, in order, with their controls, reveal conditions and per-render label variants (NZC-102). Labels and hints may carry {scopedTo} / {manualHint} placeholders the interpreter substitutes.';
COMMENT ON COLUMN nzi_console.input_spec_fields.when_lean IS
  'true = only under lean capture, false = only when not lean, NULL = either. Whether a render IS lean is computed by the interpreter (leanCapture AND crm AND new), never stored.';


-- ── The spec itself ────────────────────────────────────────────────────────────────────────
--
-- Generated from the hand-written model this replaces, then checked: the interpreter
-- reproduces all 160 pinned renders exactly. Every category is seeded, not a sample — the
-- renderer reads the spec wholesale, so a partial seed would mean two sources of truth.

INSERT INTO nzi_console.input_spec_categories (category_code, reference_category_key, scope, name, kind, units, manual_entry_hint, created_by, updated_by) VALUES
  ('1.natural-gas', 'emission_category', '1', 'Natural Gas', 'manual', ARRAY['kWh','litres','tonnes','km','mi','m²','units'], 'make · model · fuel', 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.natural-gas', 'siteBanner', 10, 'banner', 'Site', 'This entry is allocated to the site chosen at the top of data entry.', NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.natural-gas', 'activity', 20, 'smart-search', 'Activity / source', 'Smart search — {scopedTo} factors only.', NULL, NULL, NULL, NULL, '[{"audience":"portal","mode":"new","lean":false,"label":"Activity"},{"audience":"portal","mode":"existing","lean":false,"label":"Activity"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.natural-gas', 'quantity', 30, 'number', 'Quantity', NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.natural-gas', 'unit', 40, 'unit-select', 'Unit', NULL, false, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.natural-gas', 'monthly', 50, 'months', 'Add monthly breakdown', 'Reporting-period aligned (NZC-032).', true, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.natural-gas', 'factor', 60, 'factor-select', 'Emission factor', 'Set from the selected activity; limited to {scopedTo}.', NULL, ARRAY['crm'], NULL, NULL, '[{"audience":"crm","mode":"new","lean":true,"hint":"Matched from the activity you picked — refine or override in the row''s evidence panel after saving.","control":"factor-review"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.natural-gas', 'qualityTier', 70, 'select', 'Quality tier', NULL, NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.natural-gas', 'dataConfidence', 80, 'select', 'Data confidence', 'NZC-044.', NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.natural-gas', 'note', 90, 'textarea', 'Notes', NULL, true, NULL, NULL, false, '[{"audience":"portal","mode":"new","lean":false,"label":"Evidence note"},{"audience":"portal","mode":"existing","lean":false,"label":"Evidence note"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.natural-gas', 'documents', 100, 'dropzone', 'Supporting documents', 'PDF · image · spreadsheet · virus-scanned on upload.', true, NULL, NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.natural-gas', 'lineage', 110, 'lineage', 'Calculation lineage', 'Scope 1 · Direct · provenance travels with the row.', NULL, ARRAY['crm'], ARRAY['existing'], false, '[]'::jsonb, 'migration:0093', 'migration:0093');

INSERT INTO nzi_console.input_spec_categories (category_code, reference_category_key, scope, name, kind, units, manual_entry_hint, created_by, updated_by) VALUES
  ('1.company-vehicles', 'emission_category', '1', 'Company Vehicles', 'vehicle', ARRAY['kWh','litres','tonnes','km','mi','m²','units'], 'make · model · fuel', 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.company-vehicles', 'siteBanner', 10, 'banner', 'Site', 'This entry is allocated to the site chosen at the top of data entry.', NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.company-vehicles', 'registrationFinder', 20, 'registration', 'Vehicle', 'DVLA registration lookup, or enter {manualHint} manually.', NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.company-vehicles', 'activity', 30, 'smart-search', 'Activity / source', 'Smart search — {scopedTo} factors only.', NULL, NULL, NULL, NULL, '[{"audience":"portal","mode":"new","lean":false,"label":"Activity"},{"audience":"portal","mode":"existing","lean":false,"label":"Activity"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.company-vehicles', 'quantity', 40, 'number', 'Quantity', NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.company-vehicles', 'unit', 50, 'unit-select', 'Unit', NULL, false, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.company-vehicles', 'monthly', 60, 'months', 'Add monthly breakdown', 'Reporting-period aligned (NZC-032).', true, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.company-vehicles', 'factor', 70, 'factor-select', 'Emission factor', 'Set from the selected activity; limited to {scopedTo}.', NULL, ARRAY['crm'], NULL, NULL, '[{"audience":"crm","mode":"new","lean":true,"hint":"Matched from the activity you picked — refine or override in the row''s evidence panel after saving.","control":"factor-review"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.company-vehicles', 'qualityTier', 80, 'select', 'Quality tier', NULL, NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.company-vehicles', 'dataConfidence', 90, 'select', 'Data confidence', 'NZC-044.', NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.company-vehicles', 'note', 100, 'textarea', 'Notes', NULL, true, NULL, NULL, false, '[{"audience":"portal","mode":"new","lean":false,"label":"Evidence note"},{"audience":"portal","mode":"existing","lean":false,"label":"Evidence note"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.company-vehicles', 'documents', 110, 'dropzone', 'Supporting documents', 'PDF · image · spreadsheet · virus-scanned on upload.', true, NULL, NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.company-vehicles', 'lineage', 120, 'lineage', 'Calculation lineage', 'Scope 1 · Direct · provenance travels with the row.', NULL, ARRAY['crm'], ARRAY['existing'], false, '[]'::jsonb, 'migration:0093', 'migration:0093');

INSERT INTO nzi_console.input_spec_categories (category_code, reference_category_key, scope, name, kind, units, manual_entry_hint, created_by, updated_by) VALUES
  ('1.refrigerants', 'emission_category', '1', 'Refrigerants', 'fugitive', ARRAY['kWh','litres','tonnes','km','mi','m²','units'], 'make · model · fuel', 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.refrigerants', 'siteBanner', 10, 'banner', 'Site', 'This entry is allocated to the site chosen at the top of data entry.', NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.refrigerants', 'activity', 20, 'smart-search', 'Activity / source', 'Smart search — {scopedTo} factors only.', NULL, NULL, NULL, NULL, '[{"audience":"portal","mode":"new","lean":false,"label":"Activity"},{"audience":"portal","mode":"existing","lean":false,"label":"Activity"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.refrigerants', 'quantity', 30, 'number', 'Quantity', NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.refrigerants', 'unit', 40, 'unit-select', 'Unit', NULL, false, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.refrigerants', 'monthly', 50, 'months', 'Add monthly breakdown', 'Reporting-period aligned (NZC-032).', true, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.refrigerants', 'factor', 60, 'factor-select', 'Emission factor', 'Set from the selected activity; limited to {scopedTo}.', NULL, ARRAY['crm'], NULL, NULL, '[{"audience":"crm","mode":"new","lean":true,"hint":"Matched from the activity you picked — refine or override in the row''s evidence panel after saving.","control":"factor-review"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.refrigerants', 'qualityTier', 70, 'select', 'Quality tier', NULL, NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.refrigerants', 'dataConfidence', 80, 'select', 'Data confidence', 'NZC-044.', NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.refrigerants', 'note', 90, 'textarea', 'Notes', NULL, true, NULL, NULL, false, '[{"audience":"portal","mode":"new","lean":false,"label":"Evidence note"},{"audience":"portal","mode":"existing","lean":false,"label":"Evidence note"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.refrigerants', 'documents', 100, 'dropzone', 'Supporting documents', 'PDF · image · spreadsheet · virus-scanned on upload.', true, NULL, NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('1.refrigerants', 'lineage', 110, 'lineage', 'Calculation lineage', 'Scope 1 · Direct · provenance travels with the row.', NULL, ARRAY['crm'], ARRAY['existing'], false, '[]'::jsonb, 'migration:0093', 'migration:0093');

INSERT INTO nzi_console.input_spec_categories (category_code, reference_category_key, scope, name, kind, units, manual_entry_hint, created_by, updated_by) VALUES
  ('2.purchased-electricity', 'emission_category', '2', 'Purchased Electricity', 'manual', ARRAY['kWh','litres','tonnes','km','mi','m²','units'], 'make · model · fuel', 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('2.purchased-electricity', 'siteBanner', 10, 'banner', 'Site', 'This entry is allocated to the site chosen at the top of data entry.', NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('2.purchased-electricity', 'activity', 20, 'smart-search', 'Activity / source', 'Smart search — {scopedTo} factors only.', NULL, NULL, NULL, NULL, '[{"audience":"portal","mode":"new","lean":false,"label":"Activity"},{"audience":"portal","mode":"existing","lean":false,"label":"Activity"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('2.purchased-electricity', 'quantity', 30, 'number', 'Quantity', NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('2.purchased-electricity', 'unit', 40, 'unit-select', 'Unit', NULL, false, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('2.purchased-electricity', 'monthly', 50, 'months', 'Add monthly breakdown', 'Reporting-period aligned (NZC-032).', true, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('2.purchased-electricity', 'factor', 60, 'factor-select', 'Emission factor', 'Set from the selected activity; limited to {scopedTo}.', NULL, ARRAY['crm'], NULL, NULL, '[{"audience":"crm","mode":"new","lean":true,"hint":"Matched from the activity you picked — refine or override in the row''s evidence panel after saving.","control":"factor-review"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('2.purchased-electricity', 'qualityTier', 70, 'select', 'Quality tier', NULL, NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('2.purchased-electricity', 'dataConfidence', 80, 'select', 'Data confidence', 'NZC-044.', NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('2.purchased-electricity', 'note', 90, 'textarea', 'Notes', NULL, true, NULL, NULL, false, '[{"audience":"portal","mode":"new","lean":false,"label":"Evidence note"},{"audience":"portal","mode":"existing","lean":false,"label":"Evidence note"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('2.purchased-electricity', 'documents', 100, 'dropzone', 'Supporting documents', 'PDF · image · spreadsheet · virus-scanned on upload.', true, NULL, NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('2.purchased-electricity', 'lineage', 110, 'lineage', 'Calculation lineage', 'Scope 2 · Purchased energy · provenance travels with the row.', NULL, ARRAY['crm'], ARRAY['existing'], false, '[]'::jsonb, 'migration:0093', 'migration:0093');

INSERT INTO nzi_console.input_spec_categories (category_code, reference_category_key, scope, name, kind, units, manual_entry_hint, created_by, updated_by) VALUES
  ('2.renewable-electricity', 'emission_category', '2', 'Renewable Electricity', 'manual', ARRAY['kWh','litres','tonnes','km','mi','m²','units'], 'make · model · fuel', 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('2.renewable-electricity', 'siteBanner', 10, 'banner', 'Site', 'This entry is allocated to the site chosen at the top of data entry.', NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('2.renewable-electricity', 'activity', 20, 'smart-search', 'Activity / source', 'Smart search — {scopedTo} factors only.', NULL, NULL, NULL, NULL, '[{"audience":"portal","mode":"new","lean":false,"label":"Activity"},{"audience":"portal","mode":"existing","lean":false,"label":"Activity"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('2.renewable-electricity', 'quantity', 30, 'number', 'Quantity', NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('2.renewable-electricity', 'unit', 40, 'unit-select', 'Unit', NULL, false, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('2.renewable-electricity', 'monthly', 50, 'months', 'Add monthly breakdown', 'Reporting-period aligned (NZC-032).', true, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('2.renewable-electricity', 'factor', 60, 'factor-select', 'Emission factor', 'Set from the selected activity; limited to {scopedTo}.', NULL, ARRAY['crm'], NULL, NULL, '[{"audience":"crm","mode":"new","lean":true,"hint":"Matched from the activity you picked — refine or override in the row''s evidence panel after saving.","control":"factor-review"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('2.renewable-electricity', 'qualityTier', 70, 'select', 'Quality tier', NULL, NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('2.renewable-electricity', 'dataConfidence', 80, 'select', 'Data confidence', 'NZC-044.', NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('2.renewable-electricity', 'note', 90, 'textarea', 'Notes', NULL, true, NULL, NULL, false, '[{"audience":"portal","mode":"new","lean":false,"label":"Evidence note"},{"audience":"portal","mode":"existing","lean":false,"label":"Evidence note"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('2.renewable-electricity', 'documents', 100, 'dropzone', 'Supporting documents', 'PDF · image · spreadsheet · virus-scanned on upload.', true, NULL, NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('2.renewable-electricity', 'lineage', 110, 'lineage', 'Calculation lineage', 'Scope 2 · Purchased energy · provenance travels with the row.', NULL, ARRAY['crm'], ARRAY['existing'], false, '[]'::jsonb, 'migration:0093', 'migration:0093');

INSERT INTO nzi_console.input_spec_categories (category_code, reference_category_key, scope, name, kind, units, manual_entry_hint, created_by, updated_by) VALUES
  ('3.1', 'emission_category', '3', 'Purchased Goods and Services', 'spend', ARRAY['GBP','litres','tonnes','km','mi','m²','units'], 'make · model · fuel', 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.1', 'siteBanner', 10, 'banner', 'Site', 'This entry is allocated to the site chosen at the top of data entry.', NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.1', 'activity', 20, 'smart-search', 'Activity / source', 'Smart search — {scopedTo} factors only.', NULL, NULL, NULL, NULL, '[{"audience":"portal","mode":"new","lean":false,"label":"Supplier / description"},{"audience":"portal","mode":"existing","lean":false,"label":"Supplier / description"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.1', 'quantity', 30, 'number', 'Net value (£)', NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.1', 'unit', 40, 'number', 'VAT %', NULL, true, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.1', 'monthly', 50, 'months', 'Add monthly breakdown', 'Reporting-period aligned (NZC-032).', true, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.1', 'spendDetails', 60, 'spend-group', 'Spend details', 'GL / nominal code and PG&S sub-category. Consultant maps factors and syncs to Scope 3.1.', NULL, NULL, NULL, NULL, '[{"audience":"portal","mode":"new","lean":false,"hint":"GL / nominal code and your authorised purchased-goods category."},{"audience":"portal","mode":"existing","lean":false,"hint":"GL / nominal code and your authorised purchased-goods category."}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.1', 'factor', 70, 'factor-select', 'Emission factor', 'Set from the selected activity; limited to {scopedTo}.', NULL, ARRAY['crm'], NULL, NULL, '[{"audience":"crm","mode":"new","lean":true,"hint":"Matched from the activity you picked — refine or override in the row''s evidence panel after saving.","control":"factor-review"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.1', 'qualityTier', 80, 'select', 'Quality tier', NULL, NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.1', 'dataConfidence', 90, 'select', 'Data confidence', 'NZC-044.', NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.1', 'note', 100, 'textarea', 'Notes', NULL, true, NULL, NULL, false, '[{"audience":"portal","mode":"new","lean":false,"label":"Evidence note"},{"audience":"portal","mode":"existing","lean":false,"label":"Evidence note"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.1', 'documents', 110, 'dropzone', 'Supporting documents', 'PDF · image · spreadsheet · virus-scanned on upload.', true, NULL, NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.1', 'lineage', 120, 'lineage', 'Calculation lineage', 'Scope 3 · Value chain · provenance travels with the row.', NULL, ARRAY['crm'], ARRAY['existing'], false, '[]'::jsonb, 'migration:0093', 'migration:0093');

INSERT INTO nzi_console.input_spec_categories (category_code, reference_category_key, scope, name, kind, units, manual_entry_hint, created_by, updated_by) VALUES
  ('3.2', 'emission_category', '3', 'Capital Goods', 'spend', ARRAY['GBP','litres','tonnes','km','mi','m²','units'], 'make · model · fuel', 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.2', 'siteBanner', 10, 'banner', 'Site', 'This entry is allocated to the site chosen at the top of data entry.', NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.2', 'activity', 20, 'smart-search', 'Activity / source', 'Smart search — {scopedTo} factors only.', NULL, NULL, NULL, NULL, '[{"audience":"portal","mode":"new","lean":false,"label":"Supplier / description"},{"audience":"portal","mode":"existing","lean":false,"label":"Supplier / description"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.2', 'quantity', 30, 'number', 'Net value (£)', NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.2', 'unit', 40, 'number', 'VAT %', NULL, true, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.2', 'monthly', 50, 'months', 'Add monthly breakdown', 'Reporting-period aligned (NZC-032).', true, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.2', 'spendDetails', 60, 'spend-group', 'Spend details', 'GL / nominal code and PG&S sub-category. Consultant maps factors and syncs to Scope 3.1.', NULL, NULL, NULL, NULL, '[{"audience":"portal","mode":"new","lean":false,"hint":"GL / nominal code and your authorised purchased-goods category."},{"audience":"portal","mode":"existing","lean":false,"hint":"GL / nominal code and your authorised purchased-goods category."}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.2', 'factor', 70, 'factor-select', 'Emission factor', 'Set from the selected activity; limited to {scopedTo}.', NULL, ARRAY['crm'], NULL, NULL, '[{"audience":"crm","mode":"new","lean":true,"hint":"Matched from the activity you picked — refine or override in the row''s evidence panel after saving.","control":"factor-review"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.2', 'qualityTier', 80, 'select', 'Quality tier', NULL, NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.2', 'dataConfidence', 90, 'select', 'Data confidence', 'NZC-044.', NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.2', 'note', 100, 'textarea', 'Notes', NULL, true, NULL, NULL, false, '[{"audience":"portal","mode":"new","lean":false,"label":"Evidence note"},{"audience":"portal","mode":"existing","lean":false,"label":"Evidence note"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.2', 'documents', 110, 'dropzone', 'Supporting documents', 'PDF · image · spreadsheet · virus-scanned on upload.', true, NULL, NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.2', 'lineage', 120, 'lineage', 'Calculation lineage', 'Scope 3 · Value chain · provenance travels with the row.', NULL, ARRAY['crm'], ARRAY['existing'], false, '[]'::jsonb, 'migration:0093', 'migration:0093');

INSERT INTO nzi_console.input_spec_categories (category_code, reference_category_key, scope, name, kind, units, manual_entry_hint, created_by, updated_by) VALUES
  ('3.3', 'emission_category', '3', 'Fuel & Energy Related', 'manual', ARRAY['kWh','litres','tonnes','km','mi','m²','units'], 'make · model · fuel', 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.3', 'siteBanner', 10, 'banner', 'Site', 'This entry is allocated to the site chosen at the top of data entry.', NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.3', 'activity', 20, 'smart-search', 'Activity / source', 'Smart search — {scopedTo} factors only.', NULL, NULL, NULL, NULL, '[{"audience":"portal","mode":"new","lean":false,"label":"Activity"},{"audience":"portal","mode":"existing","lean":false,"label":"Activity"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.3', 'quantity', 30, 'number', 'Quantity', NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.3', 'unit', 40, 'unit-select', 'Unit', NULL, false, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.3', 'monthly', 50, 'months', 'Add monthly breakdown', 'Reporting-period aligned (NZC-032).', true, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.3', 'factor', 60, 'factor-select', 'Emission factor', 'Set from the selected activity; limited to {scopedTo}.', NULL, ARRAY['crm'], NULL, NULL, '[{"audience":"crm","mode":"new","lean":true,"hint":"Matched from the activity you picked — refine or override in the row''s evidence panel after saving.","control":"factor-review"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.3', 'qualityTier', 70, 'select', 'Quality tier', NULL, NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.3', 'dataConfidence', 80, 'select', 'Data confidence', 'NZC-044.', NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.3', 'note', 90, 'textarea', 'Notes', NULL, true, NULL, NULL, false, '[{"audience":"portal","mode":"new","lean":false,"label":"Evidence note"},{"audience":"portal","mode":"existing","lean":false,"label":"Evidence note"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.3', 'documents', 100, 'dropzone', 'Supporting documents', 'PDF · image · spreadsheet · virus-scanned on upload.', true, NULL, NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.3', 'lineage', 110, 'lineage', 'Calculation lineage', 'Scope 3 · Value chain · provenance travels with the row.', NULL, ARRAY['crm'], ARRAY['existing'], false, '[]'::jsonb, 'migration:0093', 'migration:0093');

INSERT INTO nzi_console.input_spec_categories (category_code, reference_category_key, scope, name, kind, units, manual_entry_hint, created_by, updated_by) VALUES
  ('3.4', 'emission_category', '3', 'Upstream Transportation & Distribution', 'manual', ARRAY['kWh','litres','tonnes','km','mi','m²','units'], 'make · model · fuel', 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.4', 'siteBanner', 10, 'banner', 'Site', 'This entry is allocated to the site chosen at the top of data entry.', NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.4', 'activity', 20, 'smart-search', 'Activity / source', 'Smart search — {scopedTo} factors only.', NULL, NULL, NULL, NULL, '[{"audience":"portal","mode":"new","lean":false,"label":"Activity"},{"audience":"portal","mode":"existing","lean":false,"label":"Activity"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.4', 'quantity', 30, 'number', 'Quantity', NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.4', 'unit', 40, 'unit-select', 'Unit', NULL, false, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.4', 'monthly', 50, 'months', 'Add monthly breakdown', 'Reporting-period aligned (NZC-032).', true, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.4', 'factor', 60, 'factor-select', 'Emission factor', 'Set from the selected activity; limited to {scopedTo}.', NULL, ARRAY['crm'], NULL, NULL, '[{"audience":"crm","mode":"new","lean":true,"hint":"Matched from the activity you picked — refine or override in the row''s evidence panel after saving.","control":"factor-review"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.4', 'qualityTier', 70, 'select', 'Quality tier', NULL, NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.4', 'dataConfidence', 80, 'select', 'Data confidence', 'NZC-044.', NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.4', 'note', 90, 'textarea', 'Notes', NULL, true, NULL, NULL, false, '[{"audience":"portal","mode":"new","lean":false,"label":"Evidence note"},{"audience":"portal","mode":"existing","lean":false,"label":"Evidence note"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.4', 'documents', 100, 'dropzone', 'Supporting documents', 'PDF · image · spreadsheet · virus-scanned on upload.', true, NULL, NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.4', 'lineage', 110, 'lineage', 'Calculation lineage', 'Scope 3 · Value chain · provenance travels with the row.', NULL, ARRAY['crm'], ARRAY['existing'], false, '[]'::jsonb, 'migration:0093', 'migration:0093');

INSERT INTO nzi_console.input_spec_categories (category_code, reference_category_key, scope, name, kind, units, manual_entry_hint, created_by, updated_by) VALUES
  ('3.5', 'emission_category', '3', 'Waste in Operations', 'manual', ARRAY['kWh','litres','tonnes','km','mi','m²','units'], 'make · model · fuel', 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.5', 'siteBanner', 10, 'banner', 'Site', 'This entry is allocated to the site chosen at the top of data entry.', NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.5', 'activity', 20, 'smart-search', 'Activity / source', 'Smart search — {scopedTo} factors only.', NULL, NULL, NULL, NULL, '[{"audience":"portal","mode":"new","lean":false,"label":"Activity"},{"audience":"portal","mode":"existing","lean":false,"label":"Activity"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.5', 'quantity', 30, 'number', 'Quantity', NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.5', 'unit', 40, 'unit-select', 'Unit', NULL, false, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.5', 'monthly', 50, 'months', 'Add monthly breakdown', 'Reporting-period aligned (NZC-032).', true, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.5', 'factor', 60, 'factor-select', 'Emission factor', 'Set from the selected activity; limited to {scopedTo}.', NULL, ARRAY['crm'], NULL, NULL, '[{"audience":"crm","mode":"new","lean":true,"hint":"Matched from the activity you picked — refine or override in the row''s evidence panel after saving.","control":"factor-review"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.5', 'qualityTier', 70, 'select', 'Quality tier', NULL, NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.5', 'dataConfidence', 80, 'select', 'Data confidence', 'NZC-044.', NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.5', 'note', 90, 'textarea', 'Notes', NULL, true, NULL, NULL, false, '[{"audience":"portal","mode":"new","lean":false,"label":"Evidence note"},{"audience":"portal","mode":"existing","lean":false,"label":"Evidence note"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.5', 'documents', 100, 'dropzone', 'Supporting documents', 'PDF · image · spreadsheet · virus-scanned on upload.', true, NULL, NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.5', 'lineage', 110, 'lineage', 'Calculation lineage', 'Scope 3 · Value chain · provenance travels with the row.', NULL, ARRAY['crm'], ARRAY['existing'], false, '[]'::jsonb, 'migration:0093', 'migration:0093');

INSERT INTO nzi_console.input_spec_categories (category_code, reference_category_key, scope, name, kind, units, manual_entry_hint, created_by, updated_by) VALUES
  ('3.6', 'emission_category', '3', 'Business Travel', 'travel', ARRAY['passenger.km','passenger.mi','kWh','litres','tonnes','km','mi','m²','units'], 'air · rail · hotel', 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.6', 'siteBanner', 10, 'banner', 'Site', 'This entry is allocated to the site chosen at the top of data entry.', NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.6', 'registrationFinder', 20, 'registration', 'Vehicle', 'DVLA registration lookup, or enter {manualHint} manually.', NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.6', 'activity', 30, 'smart-search', 'Activity / source', 'Smart search — {scopedTo} factors only.', NULL, NULL, NULL, NULL, '[{"audience":"portal","mode":"new","lean":false,"label":"Activity"},{"audience":"portal","mode":"existing","lean":false,"label":"Activity"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.6', 'quantity', 40, 'number', 'Quantity', NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.6', 'unit', 50, 'unit-select', 'Unit', NULL, false, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.6', 'monthly', 60, 'months', 'Add monthly breakdown', 'Reporting-period aligned (NZC-032).', true, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.6', 'factor', 70, 'factor-select', 'Emission factor', 'Set from the selected activity; limited to {scopedTo}.', NULL, ARRAY['crm'], NULL, NULL, '[{"audience":"crm","mode":"new","lean":true,"hint":"Matched from the activity you picked — refine or override in the row''s evidence panel after saving.","control":"factor-review"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.6', 'qualityTier', 80, 'select', 'Quality tier', NULL, NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.6', 'dataConfidence', 90, 'select', 'Data confidence', 'NZC-044.', NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.6', 'note', 100, 'textarea', 'Notes', NULL, true, NULL, NULL, false, '[{"audience":"portal","mode":"new","lean":false,"label":"Evidence note"},{"audience":"portal","mode":"existing","lean":false,"label":"Evidence note"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.6', 'documents', 110, 'dropzone', 'Supporting documents', 'PDF · image · spreadsheet · virus-scanned on upload.', true, NULL, NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.6', 'lineage', 120, 'lineage', 'Calculation lineage', 'Scope 3 · Value chain · provenance travels with the row.', NULL, ARRAY['crm'], ARRAY['existing'], false, '[]'::jsonb, 'migration:0093', 'migration:0093');

INSERT INTO nzi_console.input_spec_categories (category_code, reference_category_key, scope, name, kind, units, manual_entry_hint, created_by, updated_by) VALUES
  ('3.7', 'emission_category', '3', 'Employee Commuting', 'commuting', ARRAY['passenger.km','passenger.mi','kWh','litres','tonnes','km','mi','m²','units'], 'mode · WFH days', 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.7', 'siteBanner', 10, 'banner', 'Site', 'This entry is allocated to the site chosen at the top of data entry.', NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.7', 'registrationFinder', 20, 'registration', 'Vehicle / mode', 'DVLA registration lookup, or enter {manualHint} manually.', NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.7', 'activity', 30, 'smart-search', 'Activity / source', 'Smart search — {scopedTo} factors only.', NULL, NULL, NULL, NULL, '[{"audience":"portal","mode":"new","lean":false,"label":"Activity"},{"audience":"portal","mode":"existing","lean":false,"label":"Activity"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.7', 'quantity', 40, 'number', 'Quantity', NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.7', 'unit', 50, 'unit-select', 'Unit', NULL, false, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.7', 'monthly', 60, 'months', 'Add monthly breakdown', 'Reporting-period aligned (NZC-032).', true, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.7', 'factor', 70, 'factor-select', 'Emission factor', 'Set from the selected activity; limited to {scopedTo}.', NULL, ARRAY['crm'], NULL, NULL, '[{"audience":"crm","mode":"new","lean":true,"hint":"Matched from the activity you picked — refine or override in the row''s evidence panel after saving.","control":"factor-review"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.7', 'qualityTier', 80, 'select', 'Quality tier', NULL, NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.7', 'dataConfidence', 90, 'select', 'Data confidence', 'NZC-044.', NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.7', 'note', 100, 'textarea', 'Notes', NULL, true, NULL, NULL, false, '[{"audience":"portal","mode":"new","lean":false,"label":"Evidence note"},{"audience":"portal","mode":"existing","lean":false,"label":"Evidence note"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.7', 'documents', 110, 'dropzone', 'Supporting documents', 'PDF · image · spreadsheet · virus-scanned on upload.', true, NULL, NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.7', 'lineage', 120, 'lineage', 'Calculation lineage', 'Scope 3 · Value chain · provenance travels with the row.', NULL, ARRAY['crm'], ARRAY['existing'], false, '[]'::jsonb, 'migration:0093', 'migration:0093');

INSERT INTO nzi_console.input_spec_categories (category_code, reference_category_key, scope, name, kind, units, manual_entry_hint, created_by, updated_by) VALUES
  ('3.8', 'emission_category', '3', 'Upstream Leased Assets', 'manual', ARRAY['kWh','litres','tonnes','km','mi','m²','units'], 'make · model · fuel', 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.8', 'siteBanner', 10, 'banner', 'Site', 'This entry is allocated to the site chosen at the top of data entry.', NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.8', 'activity', 20, 'smart-search', 'Activity / source', 'Smart search — {scopedTo} factors only.', NULL, NULL, NULL, NULL, '[{"audience":"portal","mode":"new","lean":false,"label":"Activity"},{"audience":"portal","mode":"existing","lean":false,"label":"Activity"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.8', 'quantity', 30, 'number', 'Quantity', NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.8', 'unit', 40, 'unit-select', 'Unit', NULL, false, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.8', 'monthly', 50, 'months', 'Add monthly breakdown', 'Reporting-period aligned (NZC-032).', true, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.8', 'factor', 60, 'factor-select', 'Emission factor', 'Set from the selected activity; limited to {scopedTo}.', NULL, ARRAY['crm'], NULL, NULL, '[{"audience":"crm","mode":"new","lean":true,"hint":"Matched from the activity you picked — refine or override in the row''s evidence panel after saving.","control":"factor-review"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.8', 'qualityTier', 70, 'select', 'Quality tier', NULL, NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.8', 'dataConfidence', 80, 'select', 'Data confidence', 'NZC-044.', NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.8', 'note', 90, 'textarea', 'Notes', NULL, true, NULL, NULL, false, '[{"audience":"portal","mode":"new","lean":false,"label":"Evidence note"},{"audience":"portal","mode":"existing","lean":false,"label":"Evidence note"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.8', 'documents', 100, 'dropzone', 'Supporting documents', 'PDF · image · spreadsheet · virus-scanned on upload.', true, NULL, NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.8', 'lineage', 110, 'lineage', 'Calculation lineage', 'Scope 3 · Value chain · provenance travels with the row.', NULL, ARRAY['crm'], ARRAY['existing'], false, '[]'::jsonb, 'migration:0093', 'migration:0093');

INSERT INTO nzi_console.input_spec_categories (category_code, reference_category_key, scope, name, kind, units, manual_entry_hint, created_by, updated_by) VALUES
  ('3.9', 'emission_category', '3', 'Downstream Transportation & Distribution', 'manual', ARRAY['kWh','litres','tonnes','km','mi','m²','units'], 'make · model · fuel', 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.9', 'siteBanner', 10, 'banner', 'Site', 'This entry is allocated to the site chosen at the top of data entry.', NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.9', 'activity', 20, 'smart-search', 'Activity / source', 'Smart search — {scopedTo} factors only.', NULL, NULL, NULL, NULL, '[{"audience":"portal","mode":"new","lean":false,"label":"Activity"},{"audience":"portal","mode":"existing","lean":false,"label":"Activity"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.9', 'quantity', 30, 'number', 'Quantity', NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.9', 'unit', 40, 'unit-select', 'Unit', NULL, false, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.9', 'monthly', 50, 'months', 'Add monthly breakdown', 'Reporting-period aligned (NZC-032).', true, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.9', 'factor', 60, 'factor-select', 'Emission factor', 'Set from the selected activity; limited to {scopedTo}.', NULL, ARRAY['crm'], NULL, NULL, '[{"audience":"crm","mode":"new","lean":true,"hint":"Matched from the activity you picked — refine or override in the row''s evidence panel after saving.","control":"factor-review"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.9', 'qualityTier', 70, 'select', 'Quality tier', NULL, NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.9', 'dataConfidence', 80, 'select', 'Data confidence', 'NZC-044.', NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.9', 'note', 90, 'textarea', 'Notes', NULL, true, NULL, NULL, false, '[{"audience":"portal","mode":"new","lean":false,"label":"Evidence note"},{"audience":"portal","mode":"existing","lean":false,"label":"Evidence note"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.9', 'documents', 100, 'dropzone', 'Supporting documents', 'PDF · image · spreadsheet · virus-scanned on upload.', true, NULL, NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.9', 'lineage', 110, 'lineage', 'Calculation lineage', 'Scope 3 · Value chain · provenance travels with the row.', NULL, ARRAY['crm'], ARRAY['existing'], false, '[]'::jsonb, 'migration:0093', 'migration:0093');

INSERT INTO nzi_console.input_spec_categories (category_code, reference_category_key, scope, name, kind, units, manual_entry_hint, created_by, updated_by) VALUES
  ('3.10', 'emission_category', '3', 'Processing of Sold Products', 'manual', ARRAY['kWh','litres','tonnes','km','mi','m²','units'], 'make · model · fuel', 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.10', 'siteBanner', 10, 'banner', 'Site', 'This entry is allocated to the site chosen at the top of data entry.', NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.10', 'activity', 20, 'smart-search', 'Activity / source', 'Smart search — {scopedTo} factors only.', NULL, NULL, NULL, NULL, '[{"audience":"portal","mode":"new","lean":false,"label":"Activity"},{"audience":"portal","mode":"existing","lean":false,"label":"Activity"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.10', 'quantity', 30, 'number', 'Quantity', NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.10', 'unit', 40, 'unit-select', 'Unit', NULL, false, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.10', 'monthly', 50, 'months', 'Add monthly breakdown', 'Reporting-period aligned (NZC-032).', true, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.10', 'factor', 60, 'factor-select', 'Emission factor', 'Set from the selected activity; limited to {scopedTo}.', NULL, ARRAY['crm'], NULL, NULL, '[{"audience":"crm","mode":"new","lean":true,"hint":"Matched from the activity you picked — refine or override in the row''s evidence panel after saving.","control":"factor-review"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.10', 'qualityTier', 70, 'select', 'Quality tier', NULL, NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.10', 'dataConfidence', 80, 'select', 'Data confidence', 'NZC-044.', NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.10', 'note', 90, 'textarea', 'Notes', NULL, true, NULL, NULL, false, '[{"audience":"portal","mode":"new","lean":false,"label":"Evidence note"},{"audience":"portal","mode":"existing","lean":false,"label":"Evidence note"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.10', 'documents', 100, 'dropzone', 'Supporting documents', 'PDF · image · spreadsheet · virus-scanned on upload.', true, NULL, NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.10', 'lineage', 110, 'lineage', 'Calculation lineage', 'Scope 3 · Value chain · provenance travels with the row.', NULL, ARRAY['crm'], ARRAY['existing'], false, '[]'::jsonb, 'migration:0093', 'migration:0093');

INSERT INTO nzi_console.input_spec_categories (category_code, reference_category_key, scope, name, kind, units, manual_entry_hint, created_by, updated_by) VALUES
  ('3.11', 'emission_category', '3', 'Use of Sold Products', 'manual', ARRAY['kWh','litres','tonnes','km','mi','m²','units'], 'make · model · fuel', 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.11', 'siteBanner', 10, 'banner', 'Site', 'This entry is allocated to the site chosen at the top of data entry.', NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.11', 'activity', 20, 'smart-search', 'Activity / source', 'Smart search — {scopedTo} factors only.', NULL, NULL, NULL, NULL, '[{"audience":"portal","mode":"new","lean":false,"label":"Activity"},{"audience":"portal","mode":"existing","lean":false,"label":"Activity"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.11', 'quantity', 30, 'number', 'Quantity', NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.11', 'unit', 40, 'unit-select', 'Unit', NULL, false, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.11', 'monthly', 50, 'months', 'Add monthly breakdown', 'Reporting-period aligned (NZC-032).', true, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.11', 'factor', 60, 'factor-select', 'Emission factor', 'Set from the selected activity; limited to {scopedTo}.', NULL, ARRAY['crm'], NULL, NULL, '[{"audience":"crm","mode":"new","lean":true,"hint":"Matched from the activity you picked — refine or override in the row''s evidence panel after saving.","control":"factor-review"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.11', 'qualityTier', 70, 'select', 'Quality tier', NULL, NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.11', 'dataConfidence', 80, 'select', 'Data confidence', 'NZC-044.', NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.11', 'note', 90, 'textarea', 'Notes', NULL, true, NULL, NULL, false, '[{"audience":"portal","mode":"new","lean":false,"label":"Evidence note"},{"audience":"portal","mode":"existing","lean":false,"label":"Evidence note"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.11', 'documents', 100, 'dropzone', 'Supporting documents', 'PDF · image · spreadsheet · virus-scanned on upload.', true, NULL, NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.11', 'lineage', 110, 'lineage', 'Calculation lineage', 'Scope 3 · Value chain · provenance travels with the row.', NULL, ARRAY['crm'], ARRAY['existing'], false, '[]'::jsonb, 'migration:0093', 'migration:0093');

INSERT INTO nzi_console.input_spec_categories (category_code, reference_category_key, scope, name, kind, units, manual_entry_hint, created_by, updated_by) VALUES
  ('3.12', 'emission_category', '3', 'End-of-Life Treatment', 'manual', ARRAY['kWh','litres','tonnes','km','mi','m²','units'], 'make · model · fuel', 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.12', 'siteBanner', 10, 'banner', 'Site', 'This entry is allocated to the site chosen at the top of data entry.', NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.12', 'activity', 20, 'smart-search', 'Activity / source', 'Smart search — {scopedTo} factors only.', NULL, NULL, NULL, NULL, '[{"audience":"portal","mode":"new","lean":false,"label":"Activity"},{"audience":"portal","mode":"existing","lean":false,"label":"Activity"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.12', 'quantity', 30, 'number', 'Quantity', NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.12', 'unit', 40, 'unit-select', 'Unit', NULL, false, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.12', 'monthly', 50, 'months', 'Add monthly breakdown', 'Reporting-period aligned (NZC-032).', true, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.12', 'factor', 60, 'factor-select', 'Emission factor', 'Set from the selected activity; limited to {scopedTo}.', NULL, ARRAY['crm'], NULL, NULL, '[{"audience":"crm","mode":"new","lean":true,"hint":"Matched from the activity you picked — refine or override in the row''s evidence panel after saving.","control":"factor-review"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.12', 'qualityTier', 70, 'select', 'Quality tier', NULL, NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.12', 'dataConfidence', 80, 'select', 'Data confidence', 'NZC-044.', NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.12', 'note', 90, 'textarea', 'Notes', NULL, true, NULL, NULL, false, '[{"audience":"portal","mode":"new","lean":false,"label":"Evidence note"},{"audience":"portal","mode":"existing","lean":false,"label":"Evidence note"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.12', 'documents', 100, 'dropzone', 'Supporting documents', 'PDF · image · spreadsheet · virus-scanned on upload.', true, NULL, NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.12', 'lineage', 110, 'lineage', 'Calculation lineage', 'Scope 3 · Value chain · provenance travels with the row.', NULL, ARRAY['crm'], ARRAY['existing'], false, '[]'::jsonb, 'migration:0093', 'migration:0093');

INSERT INTO nzi_console.input_spec_categories (category_code, reference_category_key, scope, name, kind, units, manual_entry_hint, created_by, updated_by) VALUES
  ('3.13', 'emission_category', '3', 'Downstream Leased Assets', 'manual', ARRAY['kWh','litres','tonnes','km','mi','m²','units'], 'make · model · fuel', 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.13', 'siteBanner', 10, 'banner', 'Site', 'This entry is allocated to the site chosen at the top of data entry.', NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.13', 'activity', 20, 'smart-search', 'Activity / source', 'Smart search — {scopedTo} factors only.', NULL, NULL, NULL, NULL, '[{"audience":"portal","mode":"new","lean":false,"label":"Activity"},{"audience":"portal","mode":"existing","lean":false,"label":"Activity"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.13', 'quantity', 30, 'number', 'Quantity', NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.13', 'unit', 40, 'unit-select', 'Unit', NULL, false, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.13', 'monthly', 50, 'months', 'Add monthly breakdown', 'Reporting-period aligned (NZC-032).', true, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.13', 'factor', 60, 'factor-select', 'Emission factor', 'Set from the selected activity; limited to {scopedTo}.', NULL, ARRAY['crm'], NULL, NULL, '[{"audience":"crm","mode":"new","lean":true,"hint":"Matched from the activity you picked — refine or override in the row''s evidence panel after saving.","control":"factor-review"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.13', 'qualityTier', 70, 'select', 'Quality tier', NULL, NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.13', 'dataConfidence', 80, 'select', 'Data confidence', 'NZC-044.', NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.13', 'note', 90, 'textarea', 'Notes', NULL, true, NULL, NULL, false, '[{"audience":"portal","mode":"new","lean":false,"label":"Evidence note"},{"audience":"portal","mode":"existing","lean":false,"label":"Evidence note"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.13', 'documents', 100, 'dropzone', 'Supporting documents', 'PDF · image · spreadsheet · virus-scanned on upload.', true, NULL, NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.13', 'lineage', 110, 'lineage', 'Calculation lineage', 'Scope 3 · Value chain · provenance travels with the row.', NULL, ARRAY['crm'], ARRAY['existing'], false, '[]'::jsonb, 'migration:0093', 'migration:0093');

INSERT INTO nzi_console.input_spec_categories (category_code, reference_category_key, scope, name, kind, units, manual_entry_hint, created_by, updated_by) VALUES
  ('3.14', 'emission_category', '3', 'Franchises', 'manual', ARRAY['kWh','litres','tonnes','km','mi','m²','units'], 'make · model · fuel', 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.14', 'siteBanner', 10, 'banner', 'Site', 'This entry is allocated to the site chosen at the top of data entry.', NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.14', 'activity', 20, 'smart-search', 'Activity / source', 'Smart search — {scopedTo} factors only.', NULL, NULL, NULL, NULL, '[{"audience":"portal","mode":"new","lean":false,"label":"Activity"},{"audience":"portal","mode":"existing","lean":false,"label":"Activity"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.14', 'quantity', 30, 'number', 'Quantity', NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.14', 'unit', 40, 'unit-select', 'Unit', NULL, false, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.14', 'monthly', 50, 'months', 'Add monthly breakdown', 'Reporting-period aligned (NZC-032).', true, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.14', 'factor', 60, 'factor-select', 'Emission factor', 'Set from the selected activity; limited to {scopedTo}.', NULL, ARRAY['crm'], NULL, NULL, '[{"audience":"crm","mode":"new","lean":true,"hint":"Matched from the activity you picked — refine or override in the row''s evidence panel after saving.","control":"factor-review"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.14', 'qualityTier', 70, 'select', 'Quality tier', NULL, NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.14', 'dataConfidence', 80, 'select', 'Data confidence', 'NZC-044.', NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.14', 'note', 90, 'textarea', 'Notes', NULL, true, NULL, NULL, false, '[{"audience":"portal","mode":"new","lean":false,"label":"Evidence note"},{"audience":"portal","mode":"existing","lean":false,"label":"Evidence note"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.14', 'documents', 100, 'dropzone', 'Supporting documents', 'PDF · image · spreadsheet · virus-scanned on upload.', true, NULL, NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.14', 'lineage', 110, 'lineage', 'Calculation lineage', 'Scope 3 · Value chain · provenance travels with the row.', NULL, ARRAY['crm'], ARRAY['existing'], false, '[]'::jsonb, 'migration:0093', 'migration:0093');

INSERT INTO nzi_console.input_spec_categories (category_code, reference_category_key, scope, name, kind, units, manual_entry_hint, created_by, updated_by) VALUES
  ('3.15', 'emission_category', '3', 'Investments', 'spend', ARRAY['GBP','litres','tonnes','km','mi','m²','units'], 'make · model · fuel', 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.15', 'siteBanner', 10, 'banner', 'Site', 'This entry is allocated to the site chosen at the top of data entry.', NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.15', 'activity', 20, 'smart-search', 'Activity / source', 'Smart search — {scopedTo} factors only.', NULL, NULL, NULL, NULL, '[{"audience":"portal","mode":"new","lean":false,"label":"Supplier / description"},{"audience":"portal","mode":"existing","lean":false,"label":"Supplier / description"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.15', 'quantity', 30, 'number', 'Net value (£)', NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.15', 'unit', 40, 'number', 'VAT %', NULL, true, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.15', 'monthly', 50, 'months', 'Add monthly breakdown', 'Reporting-period aligned (NZC-032).', true, NULL, NULL, NULL, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.15', 'spendDetails', 60, 'spend-group', 'Spend details', 'GL / nominal code and PG&S sub-category. Consultant maps factors and syncs to Scope 3.1.', NULL, NULL, NULL, NULL, '[{"audience":"portal","mode":"new","lean":false,"hint":"GL / nominal code and your authorised purchased-goods category."},{"audience":"portal","mode":"existing","lean":false,"hint":"GL / nominal code and your authorised purchased-goods category."}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.15', 'factor', 70, 'factor-select', 'Emission factor', 'Set from the selected activity; limited to {scopedTo}.', NULL, ARRAY['crm'], NULL, NULL, '[{"audience":"crm","mode":"new","lean":true,"hint":"Matched from the activity you picked — refine or override in the row''s evidence panel after saving.","control":"factor-review"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.15', 'qualityTier', 80, 'select', 'Quality tier', NULL, NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.15', 'dataConfidence', 90, 'select', 'Data confidence', 'NZC-044.', NULL, ARRAY['crm'], NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.15', 'note', 100, 'textarea', 'Notes', NULL, true, NULL, NULL, false, '[{"audience":"portal","mode":"new","lean":false,"label":"Evidence note"},{"audience":"portal","mode":"existing","lean":false,"label":"Evidence note"}]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.15', 'documents', 110, 'dropzone', 'Supporting documents', 'PDF · image · spreadsheet · virus-scanned on upload.', true, NULL, NULL, false, '[]'::jsonb, 'migration:0093', 'migration:0093');
INSERT INTO nzi_console.input_spec_fields (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, created_by, updated_by) VALUES
  ('3.15', 'lineage', 120, 'lineage', 'Calculation lineage', 'Scope 3 · Value chain · provenance travels with the row.', NULL, ARRAY['crm'], ARRAY['existing'], false, '[]'::jsonb, 'migration:0093', 'migration:0093');

COMMIT;
