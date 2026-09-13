-- 0075 — The action-lever library: an Admin-managed catalogue, and the client plans
-- assembled from it.
--
-- This is the PLAN half of a CRP, and it is deliberately kept apart from the measurement
-- half (scope rows). A scope row says what was emitted and carries a factor, a quality tier
-- and a provenance trail. An action says what the client intends to do about it. Letting
-- the two share a table would be how a plan starts looking like evidence.
--
-- Qualitative only, today (A2-lite). There is a slot for a modelled tCO2e impact because
-- Stage 2 needs one, but it is NULL everywhere and constrained so it can never be populated
-- without saying where the number came from. An unsourced reduction figure on a client's
-- plan is precisely the kind of thing that ends up quoted in a report.

BEGIN;

-- ── The catalogue ────────────────────────────────────────────────────────────────────
--
-- Admin-managed reference data, versioned, and deactivated rather than deleted: a lever
-- withdrawn from the catalogue must not vanish from the plans that already reference it.

CREATE TABLE nzi_console.action_levers (
  organisation_id text NOT NULL,
  lever_id text NOT NULL,
  lever_key text NOT NULL CHECK (lever_key = lower(trim(lever_key)) AND lever_key <> ''),
  title text NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  -- The GHG scope the lever acts on. 'governance' is not a scope and is stored as its own
  -- value rather than squeezed into one: a supplier code of conduct reduces nothing by
  -- itself, and tagging it "Scope 3" would overstate what it is.
  scope text NOT NULL CHECK (scope IN ('1', '2', '3', 'governance')),
  category text NOT NULL DEFAULT '',
  -- How much of the outcome the client actually controls. This is the grouping the plan is
  -- read by, because it is the axis a client can act on.
  sphere_of_influence text NOT NULL CHECK (sphere_of_influence IN ('direct_control', 'supply_chain', 'influence')),
  -- An `@nzi/ui` NziIcon key, never an emoji (DESIGN_CONVENTIONS §10): these render into
  -- print, and an emoji is a different glyph in every renderer.
  icon_key text NOT NULL DEFAULT 'target',
  -- Stage 2. Held here so adding quantified impact is a backfill rather than a reshape,
  -- and paired with its basis so a number can never appear without saying where it came
  -- from — the same rule as the SRS benchmark slot.
  modelled_tco2e_per_year numeric(14,3),
  modelled_impact_basis text,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz,
  PRIMARY KEY (organisation_id, lever_id),
  CONSTRAINT action_levers_modelled_impact_sourced
    CHECK (modelled_tco2e_per_year IS NULL OR nullif(trim(modelled_impact_basis), '') IS NOT NULL)
);
CREATE UNIQUE INDEX action_levers_key_idx ON nzi_console.action_levers (organisation_id, lever_key);
CREATE INDEX action_levers_active_idx ON nzi_console.action_levers (organisation_id, active, sphere_of_influence, lower(title));

COMMENT ON TABLE nzi_console.action_levers IS
  'Admin-managed catalogue of decarbonisation levers. Versioned and deactivated rather than deleted, so a withdrawn lever does not vanish from the plans already referencing it.';
COMMENT ON COLUMN nzi_console.action_levers.modelled_tco2e_per_year IS
  'Stage 2, unpopulated today. Constrained to require a basis, so a modelled reduction can never appear on a plan without saying where it came from.';

ALTER TABLE nzi_console.action_levers ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.action_levers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.action_levers
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.action_levers TO nzi_console_app;
REVOKE DELETE ON nzi_console.action_levers FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

-- ── A client's plan ──────────────────────────────────────────────────────────────────
--
-- One row per action the client has taken on. A catalogue action points at its lever and
-- reads its title, scope and grouping from there — so an Admin correcting a lever corrects
-- it everywhere, rather than leaving every plan holding a stale copy. A bespoke action has
-- no lever and therefore carries its own, which is the only reason those columns exist.

CREATE TABLE nzi_console.client_actions (
  organisation_id text NOT NULL,
  client_action_id text NOT NULL,
  client_id text NOT NULL,
  lever_id text,
  -- Set only for a bespoke action. Enforced below.
  bespoke_title text,
  bespoke_scope text CHECK (bespoke_scope IS NULL OR bespoke_scope IN ('1', '2', '3', 'governance')),
  bespoke_category text,
  bespoke_sphere_of_influence text CHECK (bespoke_sphere_of_influence IS NULL OR bespoke_sphere_of_influence IN ('direct_control', 'supply_chain', 'influence')),
  bespoke_icon_key text,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'complete')),
  owner text NOT NULL DEFAULT '',
  target_date date,
  progress_pct integer NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 4000),
  -- Removing an action from a plan deactivates it: what a client once intended to do is
  -- part of the history of the engagement, and a report citing it must not dangle.
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz,
  PRIMARY KEY (organisation_id, client_action_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, lever_id) REFERENCES nzi_console.action_levers(organisation_id, lever_id),
  -- Exactly one of the two shapes: it is from the catalogue, or it stands on its own.
  CONSTRAINT client_actions_lever_or_bespoke CHECK (
    (lever_id IS NOT NULL AND bespoke_title IS NULL)
    OR (lever_id IS NULL AND nullif(trim(bespoke_title), '') IS NOT NULL AND bespoke_sphere_of_influence IS NOT NULL AND bespoke_scope IS NOT NULL)
  ),
  -- "Done" means one thing. A complete action at 60%, or a 100% action still in progress,
  -- are both a plan disagreeing with itself in front of the client.
  CONSTRAINT client_actions_complete_is_100 CHECK ((status = 'complete') = (progress_pct = 100))
);
CREATE INDEX client_actions_client_idx ON nzi_console.client_actions (organisation_id, client_id, active);
-- One live assignment per lever per client: assigning the same lever twice is a mistake,
-- not a plan with two of it. Deactivated rows are excluded so it can be re-added later.
CREATE UNIQUE INDEX client_actions_one_live_per_lever_idx
  ON nzi_console.client_actions (organisation_id, client_id, lever_id)
  WHERE lever_id IS NOT NULL AND active;

COMMENT ON TABLE nzi_console.client_actions IS
  'A client''s decarbonisation plan: levers assigned from the catalogue plus bespoke actions. Qualitative (A2-lite) — no modelled tCO2e, no write-back to reported figures. Deactivated, never deleted.';

ALTER TABLE nzi_console.client_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_actions
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.client_actions TO nzi_console_app;
REVOKE DELETE ON nzi_console.client_actions FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

-- ── Seed ─────────────────────────────────────────────────────────────────────────────
--
-- The levers the v12 design shows, plus the rest of the set they were drawn from. Icon
-- keys are `@nzi/ui` NziIcon names. No modelled impact: every one of these is qualitative
-- until Stage 2 gives it a sourced figure.

INSERT INTO nzi_console.action_levers
  (organisation_id, lever_id, lever_key, title, scope, category, sphere_of_influence, icon_key, description, created_by)
SELECT o.organisation_id, 'lever-' || seed.lever_key, seed.lever_key, seed.title, seed.scope, seed.category,
       seed.sphere, seed.icon, seed.description, 'system:0075'
FROM nzi_console.organisations o
CROSS JOIN (VALUES
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
) AS seed(lever_key, title, scope, category, sphere, icon, description)
ON CONFLICT DO NOTHING;

COMMIT;
