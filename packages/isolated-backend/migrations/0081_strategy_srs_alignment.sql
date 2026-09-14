-- 0081 — Every reduction strategy is aligned to an SRS requirement, and each one says
-- whether it belongs in the report.
--
-- Two things, both per the Reduction Strategies brief §3–§4.
--
-- **Alignment.** A strategy exists to advance something the client has to disclose. Making
-- that link explicit is what lets the SRS readiness view answer "which strategies close
-- this gap?" and the strategy answer "what is this for?". Library strategies carry a
-- DEFAULT alignment; a client's copy inherits it and must carry at least one.
--
-- Mandatory is enforced by a DEFERRED constraint trigger rather than a CHECK, because the
-- rule spans two tables: the strategy row and its alignments are inserted in the same
-- transaction, so an immediate check would fire before the alignments exist. Deferring to
-- COMMIT is what makes "a client strategy cannot be saved without an alignment" true in the
-- database rather than only in the command that happens to be calling today.
--
-- **include_in_report.** A per-strategy flag, default true. The report's plan section
-- renders only the included ones — and, because an issued report must not move, the flag is
-- read when the composition is frozen, never afterwards.

BEGIN;

-- ── Default alignment on a library strategy ──────────────────────────────────────────

CREATE TABLE nzi_console.strategy_srs_requirements (
  organisation_id text NOT NULL,
  strategy_id text NOT NULL,
  framework_id text NOT NULL,
  requirement_id text NOT NULL,
  PRIMARY KEY (organisation_id, strategy_id, framework_id, requirement_id),
  FOREIGN KEY (organisation_id, strategy_id) REFERENCES nzi_console.reduction_strategies(organisation_id, strategy_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, framework_id, requirement_id) REFERENCES nzi_console.srs_requirements(organisation_id, framework_id, requirement_id) ON DELETE CASCADE
);
CREATE INDEX strategy_srs_requirements_requirement_idx
  ON nzi_console.strategy_srs_requirements (organisation_id, framework_id, requirement_id);

COMMENT ON TABLE nzi_console.strategy_srs_requirements IS
  'The default SRS requirements a library strategy advances. A client copy inherits these and may then change them. Framework-scoped: an alignment is made against the version that was in force, so publishing a new framework version leaves earlier alignments pointing at what they actually meant.';

ALTER TABLE nzi_console.strategy_srs_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.strategy_srs_requirements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.strategy_srs_requirements
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
-- Re-aligning a library strategy is an edit to the allocation, not a record to preserve.
GRANT SELECT, INSERT, DELETE ON nzi_console.strategy_srs_requirements TO nzi_console_app;

-- ── Alignment on a client's strategy ─────────────────────────────────────────────────

CREATE TABLE nzi_console.client_strategy_srs_requirements (
  organisation_id text NOT NULL,
  client_strategy_id text NOT NULL,
  framework_id text NOT NULL,
  requirement_id text NOT NULL,
  PRIMARY KEY (organisation_id, client_strategy_id, framework_id, requirement_id),
  FOREIGN KEY (organisation_id, client_strategy_id) REFERENCES nzi_console.client_strategies(organisation_id, client_strategy_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, framework_id, requirement_id) REFERENCES nzi_console.srs_requirements(organisation_id, framework_id, requirement_id) ON DELETE CASCADE
);
CREATE INDEX client_strategy_srs_requirements_requirement_idx
  ON nzi_console.client_strategy_srs_requirements (organisation_id, framework_id, requirement_id);

COMMENT ON TABLE nzi_console.client_strategy_srs_requirements IS
  'Which SRS requirements a client strategy advances. At least one is mandatory, enforced by a deferred constraint trigger so the strategy and its alignments can be written in one transaction.';

ALTER TABLE nzi_console.client_strategy_srs_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_strategy_srs_requirements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_strategy_srs_requirements
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, DELETE ON nzi_console.client_strategy_srs_requirements TO nzi_console_app;

-- ── "At least one", enforced where it cannot be dodged ───────────────────────────────
--
-- A CHECK cannot express this: the rule is about rows in another table. A trigger firing
-- immediately cannot either, because the alignments are inserted after the strategy inside
-- the same transaction. A DEFERRED constraint trigger fires at COMMIT, when both exist —
-- so the rule holds however the rows are written, including by hand.
--
-- Deactivated strategies are exempt: removing a strategy from a plan leaves it in the
-- record, and its alignments are not what makes that history meaningful.

CREATE FUNCTION nzi_console.client_strategy_requires_alignment()
RETURNS trigger LANGUAGE plpgsql AS $alignment$
DECLARE
  aligned integer;
  still_active boolean;
BEGIN
  SELECT active INTO still_active FROM nzi_console.client_strategies
  WHERE organisation_id = NEW.organisation_id AND client_strategy_id = NEW.client_strategy_id;
  -- Gone entirely (deleted in the same transaction) or no longer on the plan: nothing to say.
  IF still_active IS NOT TRUE THEN RETURN NULL; END IF;

  SELECT count(*) INTO aligned FROM nzi_console.client_strategy_srs_requirements
  WHERE organisation_id = NEW.organisation_id AND client_strategy_id = NEW.client_strategy_id;

  IF aligned = 0 THEN
    RAISE EXCEPTION 'Reduction strategy % has no SRS requirement aligned; every strategy on a plan must advance at least one.', NEW.client_strategy_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$alignment$;

CREATE CONSTRAINT TRIGGER client_strategy_alignment_required
  AFTER INSERT OR UPDATE ON nzi_console.client_strategies
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nzi_console.client_strategy_requires_alignment();

COMMENT ON FUNCTION nzi_console.client_strategy_requires_alignment() IS
  'Deferred to COMMIT so a strategy and its alignments can be written together. A CHECK cannot express a rule about rows in another table, and an immediate trigger would fire before the alignments exist.';

-- ── Include in report ────────────────────────────────────────────────────────────────

ALTER TABLE nzi_console.client_strategies
  ADD COLUMN include_in_report boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN nzi_console.client_strategies.include_in_report IS
  'Whether this strategy appears in the report plan section. Read when a report composition is frozen at issue, never afterwards — toggling it later cannot rewrite a report the client already holds.';

-- ── Seed the library's default alignments ────────────────────────────────────────────
--
-- Keyed on the stable requirement `code` rather than a generated id, so the mapping is
-- readable and survives regeneration. Every seeded strategy gets at least one, because a
-- client inheriting an empty default would be unable to save without picking one by hand —
-- which is a worse first experience than a sensible default they can change.

INSERT INTO nzi_console.strategy_srs_requirements (organisation_id, strategy_id, framework_id, requirement_id)
SELECT s.organisation_id, s.strategy_id, r.framework_id, r.requirement_id
FROM nzi_console.reduction_strategies s
JOIN nzi_console.srs_requirements r ON r.organisation_id = s.organisation_id
WHERE (s.strategy_key, r.code) IN (
  -- Energy and buildings work is Scope 2 measurement and the targets it feeds.
  ('renewable-tariff', 'S2 M2'), ('renewable-tariff', 'S2 M6'),
  ('solar-pv', 'S2 M2'), ('solar-pv', 'S2 S3'),
  ('heat-pump', 'S2 M1'), ('heat-pump', 'S2 S3'),
  ('led-bms', 'S2 M2'),
  ('ev-fleet', 'S2 M1'), ('ev-fleet', 'S2 S7'),
  ('waste-reduction', 'S2 M3'),
  -- Supply-chain work advances Scope 3 disclosure and the transition plan.
  ('supplier-engagement', 'S2 M3'), ('supplier-engagement', 'S2 S7'),
  ('sustainable-procurement', 'S2 M3'), ('sustainable-procurement', 'S2 R3'),
  ('recycled-packaging', 'S2 M3'),
  ('rail-first-travel', 'S2 M3'),
  ('commuting-plan', 'S2 M3'),
  ('product-take-back', 'S2 M3'), ('product-take-back', 'S2 S2'),
  -- Governance work lands on governance requirements, not on a scope.
  ('supplier-code', 'S1 G3'), ('supplier-code', 'S2 R4')
)
ON CONFLICT DO NOTHING;

-- Anything the mapping missed aligns to the transition-plan requirement rather than
-- shipping with none: a default of nothing would make the library unusable for the client
-- the mandatory rule is meant to protect.
INSERT INTO nzi_console.strategy_srs_requirements (organisation_id, strategy_id, framework_id, requirement_id)
SELECT s.organisation_id, s.strategy_id, r.framework_id, r.requirement_id
FROM nzi_console.reduction_strategies s
JOIN nzi_console.srs_requirements r ON (r.organisation_id, r.code) = (s.organisation_id, 'S2 S7')
WHERE NOT EXISTS (
  SELECT 1 FROM nzi_console.strategy_srs_requirements x
  WHERE (x.organisation_id, x.strategy_id) = (s.organisation_id, s.strategy_id)
)
ON CONFLICT DO NOTHING;

-- Existing client strategies inherit their library default, so the deferred trigger does
-- not fail the next write to a plan that predates this migration.
INSERT INTO nzi_console.client_strategy_srs_requirements (organisation_id, client_strategy_id, framework_id, requirement_id)
SELECT c.organisation_id, c.client_strategy_id, d.framework_id, d.requirement_id
FROM nzi_console.client_strategies c
JOIN nzi_console.strategy_srs_requirements d ON (d.organisation_id, d.strategy_id) = (c.organisation_id, c.strategy_id)
WHERE c.strategy_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- A bespoke strategy has no library default to inherit, so it takes the same fallback.
-- Without this the trigger would refuse the next edit to a plan that already has one.
INSERT INTO nzi_console.client_strategy_srs_requirements (organisation_id, client_strategy_id, framework_id, requirement_id)
SELECT c.organisation_id, c.client_strategy_id, r.framework_id, r.requirement_id
FROM nzi_console.client_strategies c
JOIN nzi_console.srs_requirements r ON (r.organisation_id, r.code) = (c.organisation_id, 'S2 S7')
WHERE NOT EXISTS (
  SELECT 1 FROM nzi_console.client_strategy_srs_requirements x
  WHERE (x.organisation_id, x.client_strategy_id) = (c.organisation_id, c.client_strategy_id)
)
ON CONFLICT DO NOTHING;

COMMIT;
