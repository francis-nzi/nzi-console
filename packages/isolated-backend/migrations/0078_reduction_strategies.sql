-- 0078 — Actions become Reduction Strategies, and the flat catalogue becomes a library
-- allocated to levers.
--
-- This **supersedes** the model in 0075 rather than sitting beside it. 0075 called its
-- catalogue rows "levers" and gave each one a free-text `category`. Both were wrong in the
-- same way: a lever is a *theme* a strategy belongs to, several strategies share one, and a
-- strategy can belong to more than one. A text column cannot express that, and it cannot be
-- filtered on, ordered, or given an icon.
--
-- So the concepts separate:
--
--   levers                — the Admin-managed set of themes (energy, buildings, transport…)
--   reduction_strategies  — the shared library (0075's catalogue, renamed)
--   strategy_levers       — M:N, a strategy allocated to one or more levers
--   client_strategies     — the per-client plan (0075's client_actions, renamed)
--
-- Control level stays a **separate single-value axis** (direct control / supply chain /
-- influence). It answers a different question from "which theme is this" and collapsing the
-- two would lose both answers.
--
-- Renamed, not rebuilt: the tables carry real data on staging, and `ALTER TABLE ... RENAME`
-- keeps it. Constraint and index names are renamed alongside their tables, because Postgres
-- leaves them behind and an error citing `action_levers_...` after this would send whoever
-- reads it looking for a table that no longer exists.
--
-- "Reduction Strategies", never bare "Strategies": `strategy` is already an SRS *pillar*,
-- and one-term-one-meaning is locked. The SRS pillar is untouched by this migration.

BEGIN;

-- ── Levers: the shared set of themes ─────────────────────────────────────────────────

CREATE TABLE nzi_console.levers (
  organisation_id text NOT NULL,
  lever_id text NOT NULL,
  lever_key text NOT NULL CHECK (lever_key = lower(trim(lever_key)) AND lever_key <> ''),
  title text NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 120),
  icon_key text NOT NULL DEFAULT 'target',
  ordering integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz,
  PRIMARY KEY (organisation_id, lever_id)
);
CREATE UNIQUE INDEX levers_key_idx ON nzi_console.levers (organisation_id, lever_key);
CREATE INDEX levers_order_idx ON nzi_console.levers (organisation_id, active, ordering, lower(title));

COMMENT ON TABLE nzi_console.levers IS
  'Admin-managed reduction levers — the themes a strategy belongs to. A categorisation, many-to-many with strategies; distinct from control level, which is a separate single-value axis.';

ALTER TABLE nzi_console.levers ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.levers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.levers
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.levers TO nzi_console_app;
REVOKE DELETE ON nzi_console.levers FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

-- ── The library: 0075's catalogue, renamed ───────────────────────────────────────────

ALTER TABLE nzi_console.action_levers RENAME TO reduction_strategies;
ALTER TABLE nzi_console.reduction_strategies RENAME COLUMN lever_id TO strategy_id;
ALTER TABLE nzi_console.reduction_strategies RENAME COLUMN lever_key TO strategy_key;

-- Rename every constraint and index that still carries the old name, rather than listing
-- the ones I can think of. Postgres auto-names inline CHECKs `<table>_<column>_check`, so
-- the set is knowable but easy to under-enumerate — and a constraint left named
-- `action_levers_*` would, on violation, cite a table that no longer exists.
DO $$
DECLARE entry record;
BEGIN
  FOR entry IN
    SELECT conname AS name FROM pg_constraint
    WHERE conrelid = 'nzi_console.reduction_strategies'::regclass AND conname LIKE 'action\_levers%'
  LOOP
    EXECUTE format(
      'ALTER TABLE nzi_console.reduction_strategies RENAME CONSTRAINT %I TO %I',
      entry.name,
      replace(replace(entry.name, 'action_levers', 'reduction_strategies'), '_lever_key_', '_strategy_key_'));
  END LOOP;

  FOR entry IN
    SELECT indexname AS name FROM pg_indexes
    WHERE schemaname = 'nzi_console' AND tablename = 'reduction_strategies' AND indexname LIKE 'action\_levers%'
  LOOP
    EXECUTE format(
      'ALTER INDEX nzi_console.%I RENAME TO %I',
      entry.name, replace(entry.name, 'action_levers', 'reduction_strategies'));
  END LOOP;
END $$;

COMMENT ON TABLE nzi_console.reduction_strategies IS
  'The shared library of reduction strategies. Admin-managed, versioned, deactivated rather than deleted. A client plan references these; the library wording propagates until the client customises a field.';

-- `category` is superseded by the lever join below. Kept for one migration so the mapping
-- can be derived from it, then dropped: leaving a free-text category beside a real
-- categorisation is how two answers to the same question start disagreeing.
COMMENT ON COLUMN nzi_console.reduction_strategies.category IS
  'Superseded by strategy_levers. Retained only as the source of the initial lever mapping; do not read it.';

-- ── The join: a strategy belongs to one or more levers ───────────────────────────────

CREATE TABLE nzi_console.strategy_levers (
  organisation_id text NOT NULL,
  strategy_id text NOT NULL,
  lever_id text NOT NULL,
  PRIMARY KEY (organisation_id, strategy_id, lever_id),
  FOREIGN KEY (organisation_id, strategy_id) REFERENCES nzi_console.reduction_strategies(organisation_id, strategy_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, lever_id) REFERENCES nzi_console.levers(organisation_id, lever_id) ON DELETE CASCADE
);
CREATE INDEX strategy_levers_lever_idx ON nzi_console.strategy_levers (organisation_id, lever_id);

COMMENT ON TABLE nzi_console.strategy_levers IS
  'Which levers a library strategy is allocated to. Many-to-many: a strategy can sit under more than one theme, and the plan is grouped by lever.';

ALTER TABLE nzi_console.strategy_levers ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.strategy_levers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.strategy_levers
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
-- A join row carries no history of its own: re-allocating a strategy is an edit to the
-- allocation, not a record to preserve. This is the one table here that may be deleted from.
GRANT SELECT, INSERT, DELETE ON nzi_console.strategy_levers TO nzi_console_app;

-- ── The client's plan: 0075's client_actions, renamed ────────────────────────────────

ALTER TABLE nzi_console.client_actions RENAME TO client_strategies;
ALTER TABLE nzi_console.client_strategies RENAME COLUMN client_action_id TO client_strategy_id;
ALTER TABLE nzi_console.client_strategies RENAME COLUMN lever_id TO strategy_id;

DO $$
DECLARE entry record;
BEGIN
  FOR entry IN
    SELECT conname AS name FROM pg_constraint
    WHERE conrelid = 'nzi_console.client_strategies'::regclass AND conname LIKE 'client\_actions%'
  LOOP
    EXECUTE format(
      'ALTER TABLE nzi_console.client_strategies RENAME CONSTRAINT %I TO %I',
      entry.name,
      replace(replace(replace(entry.name, 'client_actions', 'client_strategies'),
        '_lever_or_bespoke', '_library_or_bespoke'), '_client_action_id_', '_client_strategy_id_'));
  END LOOP;

  FOR entry IN
    SELECT indexname AS name FROM pg_indexes
    WHERE schemaname = 'nzi_console' AND tablename = 'client_strategies' AND indexname LIKE 'client\_actions%'
  LOOP
    EXECUTE format(
      'ALTER INDEX nzi_console.%I RENAME TO %I',
      entry.name,
      replace(replace(entry.name, 'client_actions', 'client_strategies'), '_one_live_per_lever_', '_one_live_per_strategy_'));
  END LOOP;
END $$;

COMMENT ON TABLE nzi_console.client_strategies IS
  'A client''s reduction plan: library strategies they have taken on, plus bespoke ones. Qualitative (A2-lite) — no modelled tCO2e. Deactivated, never deleted.';

-- ── Levers, seeded, and the existing library mapped onto them ────────────────────────
--
-- Seeded per organisation, which is how every other reference set here works — and, as the
-- migrations CI run showed, that means an organisation created LATER gets none of it. The
-- provisioning fix that closes this covers levers and the strategy library together; until
-- it lands the same caveat applies to this seed as to the SRS framework.

INSERT INTO nzi_console.levers (organisation_id, lever_id, lever_key, title, icon_key, ordering, created_by)
SELECT o.organisation_id, 'lever-' || seed.lever_key, seed.lever_key, seed.title, seed.icon, seed.ordering, 'system:0078'
FROM nzi_console.organisations o
CROSS JOIN (VALUES
  ('energy',      'Energy',              'energy',    1),
  ('buildings',   'Buildings & sites',   'building',  2),
  ('transport',   'Transport & travel',  'vehicle',   3),
  ('procurement', 'Procurement & supply chain', 'handshake', 4),
  ('process',     'Process & operations', 'tools',    5),
  ('waste',       'Waste & materials',   'recycle',   6),
  ('governance',  'Governance & policy', 'policy',    7)
) AS seed(lever_key, title, icon, ordering)
ON CONFLICT DO NOTHING;

-- Map the 13 library strategies onto levers, derived from the `category` they were seeded
-- with. Done as data rather than by hand so the mapping is inspectable and matches what the
-- catalogue actually says.
INSERT INTO nzi_console.strategy_levers (organisation_id, strategy_id, lever_id)
SELECT s.organisation_id, s.strategy_id, l.lever_id
FROM nzi_console.reduction_strategies s
JOIN nzi_console.levers l ON l.organisation_id = s.organisation_id
WHERE (s.strategy_key, l.lever_key) IN (
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

-- Anything the mapping missed lands under Process & operations rather than vanishing from a
-- plan grouped by lever. A strategy with no lever would simply not render.
INSERT INTO nzi_console.strategy_levers (organisation_id, strategy_id, lever_id)
SELECT s.organisation_id, s.strategy_id, l.lever_id
FROM nzi_console.reduction_strategies s
JOIN nzi_console.levers l ON (l.organisation_id, l.lever_key) = (s.organisation_id, 'process')
WHERE NOT EXISTS (
  SELECT 1 FROM nzi_console.strategy_levers x
  WHERE (x.organisation_id, x.strategy_id) = (s.organisation_id, s.strategy_id)
)
ON CONFLICT DO NOTHING;

COMMIT;
