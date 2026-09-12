BEGIN;

-- UK SRS readiness — an Admin-managed, versioned framework, and dated assessments against it.
--
-- Two halves, deliberately separate:
--
--   The FRAMEWORK is reference data: standards (S1 general, S2 climate), the four
--   ISSB/TCFD pillars, the concrete disclosure requirements under each, their weights and
--   the five-step maturity ladder. It is versioned as a whole, so when UK SRS moves (the
--   mandatory rules proposed for 2027) a new version is published as data — no code change,
--   and no silent rewriting of what earlier assessments were measured against.
--
--   An ASSESSMENT is a dated record for one client that STAMPS the framework version it
--   used. Reassessing creates another assessment, so readiness has a trend and an old
--   assessment keeps meaning what it meant.
--
-- Future-proofing that costs nothing now: the standards/requirement set is data, so extra
-- standards and the 2027 requirements are added as rows; and an assessment carries a
-- sector tag and a benchmark percentile which stay NULL until a defensible peer dataset
-- exists. Nothing invents peer data — the UI renders a "Future" state while they are null.

-- ── Framework (reference data, versioned) ────────────────────────────────────────────

CREATE TABLE nzi_console.srs_frameworks (
  organisation_id text NOT NULL,
  framework_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  label text NOT NULL,
  /* Only one version is `active` at a time; superseded versions stay readable for the
     assessments that were made against them. */
  status text NOT NULL CHECK (status IN ('draft', 'active', 'superseded')),
  effective_from date,
  notes text,
  published_by text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, framework_id)
);
CREATE UNIQUE INDEX srs_frameworks_one_active ON nzi_console.srs_frameworks (organisation_id) WHERE status = 'active';

CREATE TABLE nzi_console.srs_standards (
  organisation_id text NOT NULL,
  framework_id text NOT NULL,
  standard_key text NOT NULL,
  label text NOT NULL,
  description text NOT NULL DEFAULT '',
  /* S2 is the climate standard and leads the assessment; S1 is assessed alongside it. */
  climate_led boolean NOT NULL DEFAULT false,
  ordering integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organisation_id, framework_id, standard_key),
  FOREIGN KEY (organisation_id, framework_id) REFERENCES nzi_console.srs_frameworks(organisation_id, framework_id) ON DELETE CASCADE
);

CREATE TABLE nzi_console.srs_pillars (
  organisation_id text NOT NULL,
  framework_id text NOT NULL,
  pillar_key text NOT NULL,
  label text NOT NULL,
  description text NOT NULL DEFAULT '',
  ordering integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organisation_id, framework_id, pillar_key),
  FOREIGN KEY (organisation_id, framework_id) REFERENCES nzi_console.srs_frameworks(organisation_id, framework_id) ON DELETE CASCADE
);

CREATE TABLE nzi_console.srs_maturity_levels (
  organisation_id text NOT NULL,
  framework_id text NOT NULL,
  level smallint NOT NULL CHECK (level BETWEEN 0 AND 4),
  key text NOT NULL,
  label text NOT NULL,
  definition text NOT NULL,
  PRIMARY KEY (organisation_id, framework_id, level),
  FOREIGN KEY (organisation_id, framework_id) REFERENCES nzi_console.srs_frameworks(organisation_id, framework_id) ON DELETE CASCADE
);

CREATE TABLE nzi_console.srs_requirements (
  organisation_id text NOT NULL,
  framework_id text NOT NULL,
  requirement_id text NOT NULL,
  standard_key text NOT NULL,
  pillar_key text NOT NULL,
  code text NOT NULL,
  title text NOT NULL,
  /* Plain-language help shown on demand next to the requirement (InfoTip). */
  help_text text NOT NULL DEFAULT '',
  weight numeric(5,2) NOT NULL DEFAULT 1.00 CHECK (weight > 0),
  /* `nzi-data` requirements are answered from the client's own assured record rather than
     re-asked: the footprint, its targets and its intensity metrics. */
  source text NOT NULL DEFAULT 'entered' CHECK (source IN ('entered', 'nzi-data')),
  nzi_source_key text,
  /* What SRS expects: a requirement below this is a gap, and a gap earns an action. */
  target_maturity smallint NOT NULL DEFAULT 2 CHECK (target_maturity BETWEEN 0 AND 4),
  ordering integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (organisation_id, framework_id, requirement_id),
  FOREIGN KEY (organisation_id, framework_id) REFERENCES nzi_console.srs_frameworks(organisation_id, framework_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, framework_id, standard_key) REFERENCES nzi_console.srs_standards(organisation_id, framework_id, standard_key),
  FOREIGN KEY (organisation_id, framework_id, pillar_key) REFERENCES nzi_console.srs_pillars(organisation_id, framework_id, pillar_key),
  CONSTRAINT srs_requirements_nzi_source CHECK (source = 'entered' OR nzi_source_key IS NOT NULL)
);
CREATE INDEX srs_requirements_set_idx ON nzi_console.srs_requirements (organisation_id, framework_id, standard_key, pillar_key, ordering);

-- ── Assessments (per client, dated, stamped with the framework version) ───────────────

CREATE TABLE nzi_console.srs_assessments (
  organisation_id text NOT NULL,
  assessment_id text NOT NULL,
  client_id text NOT NULL,
  framework_id text NOT NULL,
  /* Copied, not joined: the number this assessment was made against, kept even if the
     framework row is later superseded. */
  framework_version integer NOT NULL CHECK (framework_version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'complete')),
  assessed_on date NOT NULL,
  assessed_by text NOT NULL,
  completed_at timestamptz,
  notes text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  /* Future slots — a sector tag and a peer percentile. Null until a defensible dataset
     exists; the dashboard renders "Future" rather than inventing a comparison. */
  sector_key text,
  benchmark_percentile numeric(5,2) CHECK (benchmark_percentile IS NULL OR (benchmark_percentile >= 0 AND benchmark_percentile <= 100)),
  benchmark_source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, assessment_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id),
  FOREIGN KEY (organisation_id, framework_id) REFERENCES nzi_console.srs_frameworks(organisation_id, framework_id),
  CONSTRAINT srs_assessments_complete_stamped CHECK (status <> 'complete' OR completed_at IS NOT NULL),
  CONSTRAINT srs_assessments_benchmark_sourced CHECK (benchmark_percentile IS NULL OR benchmark_source IS NOT NULL)
);
CREATE INDEX srs_assessments_client_idx ON nzi_console.srs_assessments (organisation_id, client_id, assessed_on DESC, assessment_id DESC);

CREATE TABLE nzi_console.srs_assessment_items (
  organisation_id text NOT NULL,
  assessment_id text NOT NULL,
  requirement_id text NOT NULL,
  maturity smallint CHECK (maturity IS NULL OR (maturity BETWEEN 0 AND 4)),
  /* How the answer got here. `auto` means it was resolved from the client's assured NZI
     data; the evidence reference carries the provenance of that figure. */
  source text NOT NULL DEFAULT 'entered' CHECK (source IN ('entered', 'auto')),
  evidence_kind text CHECK (evidence_kind IS NULL OR evidence_kind IN ('document', 'data', 'note')),
  evidence_ref text,
  evidence_note text NOT NULL DEFAULT '',
  owner text NOT NULL DEFAULT '',
  due_date date,
  /* A gap below target earns an action. The action lives in the action-lever library; this
     holds its id so the readiness roadmap and the decarbonisation plan share one spine.
     No foreign key yet — the lever tables arrive in their own migration, which adds it. */
  linked_action_id text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, assessment_id, requirement_id),
  FOREIGN KEY (organisation_id, assessment_id) REFERENCES nzi_console.srs_assessments(organisation_id, assessment_id) ON DELETE CASCADE,
  CONSTRAINT srs_items_evidence_pair CHECK ((evidence_kind IS NULL) = (evidence_ref IS NULL AND evidence_note = ''))
);

-- ── Tenancy ──────────────────────────────────────────────────────────────────────────

ALTER TABLE nzi_console.srs_frameworks ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.srs_frameworks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.srs_frameworks
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

ALTER TABLE nzi_console.srs_standards ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.srs_standards FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.srs_standards
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

ALTER TABLE nzi_console.srs_pillars ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.srs_pillars FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.srs_pillars
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

ALTER TABLE nzi_console.srs_maturity_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.srs_maturity_levels FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.srs_maturity_levels
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

ALTER TABLE nzi_console.srs_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.srs_requirements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.srs_requirements
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

ALTER TABLE nzi_console.srs_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.srs_assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.srs_assessments
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

ALTER TABLE nzi_console.srs_assessment_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.srs_assessment_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.srs_assessment_items
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

-- The framework is published, never edited in place: a change is a new version.
GRANT SELECT, INSERT ON nzi_console.srs_frameworks TO nzi_console_app;
GRANT SELECT, INSERT ON nzi_console.srs_standards TO nzi_console_app;
GRANT SELECT, INSERT ON nzi_console.srs_pillars TO nzi_console_app;
GRANT SELECT, INSERT ON nzi_console.srs_maturity_levels TO nzi_console_app;
GRANT SELECT, INSERT ON nzi_console.srs_requirements TO nzi_console_app;
-- Publishing a new version supersedes the one before it, which is a status change.
GRANT UPDATE (status) ON nzi_console.srs_frameworks TO nzi_console_app;
REVOKE DELETE ON nzi_console.srs_frameworks, nzi_console.srs_standards, nzi_console.srs_pillars,
  nzi_console.srs_maturity_levels, nzi_console.srs_requirements FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

-- An assessment is worked on while it is a draft, so its items are updatable; every write
-- goes through a command and leaves an audit event. Reassessment is a new assessment.
GRANT SELECT, INSERT, UPDATE ON nzi_console.srs_assessments TO nzi_console_app;
GRANT SELECT, INSERT, UPDATE ON nzi_console.srs_assessment_items TO nzi_console_app;
REVOKE DELETE ON nzi_console.srs_assessments, nzi_console.srs_assessment_items FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

-- ── Framework v1: UK SRS S1/S2, published 25 Feb 2026 ────────────────────────────────

INSERT INTO nzi_console.srs_frameworks (organisation_id, framework_id, version, label, status, effective_from, notes, published_by)
SELECT o.organisation_id, 'uk-srs-2026', 1, 'UK SRS S1 & S2 (2026)', 'active', DATE '2026-02-25',
  'UK-endorsed IFRS S1 and S2 as published on 25 February 2026. Voluntary; mandatory requirements proposed for 2027 will be published as the next framework version.',
  'migration:0070'
FROM nzi_console.organisations o;

INSERT INTO nzi_console.srs_standards (organisation_id, framework_id, standard_key, label, description, climate_led, ordering)
SELECT o.organisation_id, 'uk-srs-2026', v.standard_key, v.label, v.description, v.climate_led, v.ordering
FROM nzi_console.organisations o,
  (VALUES
    ('S2', 'UK SRS S2 — Climate', 'Climate-related disclosures: the deeper, more prescriptive standard, and where readiness effort lands first.', true, 1),
    ('S1', 'UK SRS S1 — General', 'General sustainability-related financial disclosures, covering any material sustainability risk or opportunity.', false, 2)
  ) AS v(standard_key, label, description, climate_led, ordering);

INSERT INTO nzi_console.srs_pillars (organisation_id, framework_id, pillar_key, label, description, ordering)
SELECT o.organisation_id, 'uk-srs-2026', v.pillar_key, v.label, v.description, v.ordering
FROM nzi_console.organisations o,
  (VALUES
    ('governance', 'Governance', 'Board and management oversight of sustainability-related risks and opportunities.', 1),
    ('strategy', 'Strategy', 'Material risks and opportunities, their effects on the business model, strategy and financial position, and climate resilience.', 2),
    ('risk', 'Risk management', 'How sustainability risks are identified, assessed, managed and integrated into enterprise risk.', 3),
    ('metrics', 'Metrics & targets', 'The GHG inventory, cross-industry and industry-based metrics, and the targets set.', 4)
  ) AS v(pillar_key, label, description, ordering);

INSERT INTO nzi_console.srs_maturity_levels (organisation_id, framework_id, level, key, label, definition)
SELECT o.organisation_id, 'uk-srs-2026', v.level, v.key, v.label, v.definition
FROM nzi_console.organisations o,
  (VALUES
    (0, 'not-started', 'Not started', 'Nothing is in place for this requirement yet.'),
    (1, 'developing', 'Developing', 'Work has begun: an approach exists but it is partial, informal or undocumented.'),
    (2, 'established', 'Established', 'A documented approach is in place and operating — the disclosure could be made.'),
    (3, 'advanced', 'Advanced', 'The approach is embedded, reviewed and evidenced, and meets the standard in full.'),
    (4, 'assured', 'Assured', 'Independently assured or externally verified, and ready to withstand scrutiny.')
  ) AS v(level, key, label, definition);

INSERT INTO nzi_console.srs_requirements (organisation_id, framework_id, requirement_id, standard_key, pillar_key, code, title, help_text, weight, source, nzi_source_key, target_maturity, ordering)
SELECT o.organisation_id, 'uk-srs-2026', v.requirement_id, v.standard_key, v.pillar_key, v.code, v.title, v.help_text, v.weight, v.source, v.nzi_source_key, v.target_maturity, v.ordering
FROM nzi_console.organisations o,
  (VALUES
    -- S2 · Governance
    ('s2-g1','S2','governance','S2 G1','Board body responsible for climate is identified','Name the board or committee with oversight of climate-related risks and opportunities, and say where that responsibility is recorded.',1.00,'entered',NULL,2,1),
    ('s2-g2','S2','governance','S2 G2','Terms of reference reflect climate responsibilities','The body''s terms of reference, charter or mandate explicitly cover climate-related matters.',1.00,'entered',NULL,2,2),
    ('s2-g3','S2','governance','S2 G3','Management''s role and reporting lines are defined','Which management roles assess and manage climate risks, and how they report upward.',1.00,'entered',NULL,2,3),
    ('s2-g4','S2','governance','S2 G4','Climate competence of the oversight body','How the board ensures it has the skills and information to oversee climate matters, including training.',1.00,'entered',NULL,2,4),
    ('s2-g5','S2','governance','S2 G5','Frequency of climate reporting to the board','How often, and through what route, climate matters reach the oversight body.',1.00,'entered',NULL,2,5),
    ('s2-g6','S2','governance','S2 G6','Climate in performance and remuneration','Whether climate-related targets form part of remuneration policies, and how.',0.50,'entered',NULL,1,6),
    -- S2 · Strategy
    ('s2-s1','S2','strategy','S2 S1','Climate risks and opportunities identified with time horizons','The specific climate risks and opportunities that could reasonably affect prospects, over short, medium and long term as the entity defines them.',1.50,'entered',NULL,2,1),
    ('s2-s2','S2','strategy','S2 S2','Effects on the business model and value chain','Where in the business model and value chain the identified risks and opportunities are concentrated.',1.00,'entered',NULL,2,2),
    ('s2-s3','S2','strategy','S2 S3','Effects on strategy and decision-making','How climate risks and opportunities have changed, or are expected to change, strategy and decision-making.',1.00,'entered',NULL,2,3),
    ('s2-s4','S2','strategy','S2 S4','Effects on financial position, performance and cash flows','Current financial effects, and those anticipated over the short, medium and long term.',1.50,'entered',NULL,2,4),
    ('s2-s5','S2','strategy','S2 S5','Climate resilience assessed through scenario analysis','Whether resilience has been assessed using climate-related scenario analysis, and what it showed.',1.50,'entered',NULL,2,5),
    ('s2-s6','S2','strategy','S2 S6','Scenario method, inputs and assumptions disclosed','Which scenarios were used, why they were chosen, and the key inputs and assumptions behind them.',1.00,'entered',NULL,2,6),
    ('s2-s7','S2','strategy','S2 S7','Transition plan, with assumptions and dependencies','Any climate-related transition plan, including the assumptions it rests on and what it depends on to be delivered.',1.50,'entered',NULL,2,7),
    ('s2-s8','S2','strategy','S2 S8','Planned use of carbon credits is explained','If credits are relied on, the extent, the type, and whether they are removals or reductions.',0.50,'entered',NULL,1,8),
    -- S2 · Risk management
    ('s2-r1','S2','risk','S2 R1','Process to identify and assess climate risks','The process used, including the inputs and parameters it relies on.',1.00,'entered',NULL,2,1),
    ('s2-r2','S2','risk','S2 R2','Climate risks are prioritised against other risks','How climate risks are weighed relative to the entity''s other risk types.',1.00,'entered',NULL,2,2),
    ('s2-r3','S2','risk','S2 R3','Process to monitor and manage climate risks','How identified risks are monitored, escalated and managed over time.',1.00,'entered',NULL,2,3),
    ('s2-r4','S2','risk','S2 R4','Integration into enterprise risk management','How the climate process is integrated into, rather than parallel to, the overall risk framework.',1.00,'entered',NULL,2,4),
    ('s2-r5','S2','risk','S2 R5','Process to identify climate opportunities','The equivalent process for opportunities, not only risks.',0.50,'entered',NULL,1,5),
    -- S2 · Metrics & targets — answered from the client''s own assured record where possible
    ('s2-m1','S2','metrics','S2 M1','Scope 1 gross GHG emissions disclosed','Gross Scope 1 emissions for the reporting period, in tonnes of CO2 equivalent.',1.50,'nzi-data','footprint.scope1',3,1),
    ('s2-m2','S2','metrics','S2 M2','Scope 2 gross GHG emissions disclosed','Gross Scope 2 emissions, location-based, with market-based disclosed where relevant.',1.50,'nzi-data','footprint.scope2',3,2),
    ('s2-m3','S2','metrics','S2 M3','Scope 3 GHG emissions disclosed by category','Scope 3 emissions with the categories included, and the basis for any exclusion.',1.50,'nzi-data','footprint.scope3',3,3),
    ('s2-m4','S2','metrics','S2 M4','Measurement approach, inputs and assumptions','The approach used to measure emissions — the GHG Protocol basis, the boundary, and the assumptions applied.',1.00,'nzi-data','footprint.method',3,4),
    ('s2-m5','S2','metrics','S2 M5','Emission factor sources and vintages disclosed','Which factor sets were used, their versions, and the date they were applied as at.',1.00,'nzi-data','footprint.provenance',3,5),
    ('s2-m6','S2','metrics','S2 M6','Climate-related targets disclosed','The metric, objective, period covered and base year for each target set.',1.50,'nzi-data','targets.model',3,6),
    ('s2-m7','S2','metrics','S2 M7','Progress against targets reported','Performance against each target, measured from the base year.',1.00,'nzi-data','targets.gap',3,7),
    ('s2-m8','S2','metrics','S2 M8','Intensity metrics disclosed','Emissions normalised against a business measure, with the denominator stated.',1.00,'nzi-data','intensity.metrics',2,8),
    ('s2-m9','S2','metrics','S2 M9','Industry-based metrics considered','Whether industry-based metrics have been considered and, where applicable, disclosed.',0.50,'entered',NULL,1,9),
    ('s2-m10','S2','metrics','S2 M10','Internal carbon price disclosed, if used','Whether an internal carbon price is applied, the price, and how it is used in decisions.',0.50,'entered',NULL,1,10),
    ('s2-m11','S2','metrics','S2 M11','Assets or activities vulnerable to climate risk quantified','The amount or percentage of assets and business activities vulnerable to transition and to physical risk.',1.00,'entered',NULL,2,11),
    ('s2-m12','S2','metrics','S2 M12','Capital deployed toward climate risks and opportunities','The amount of capital expenditure, financing or investment deployed toward climate-related risks and opportunities.',1.00,'entered',NULL,2,12),
    ('s2-m13','S2','metrics','S2 M13','GHG inventory independently assured','Whether the inventory has been externally verified or assured, by whom, and to what standard.',1.00,'nzi-data','footprint.assurance',2,13),
    -- S1 · Governance
    ('s1-g1','S1','governance','S1 G1','Oversight of sustainability risks beyond climate','The governance body responsible for sustainability-related risks and opportunities generally, not only climate.',1.00,'entered',NULL,2,1),
    ('s1-g2','S1','governance','S1 G2','Management''s role in sustainability governance','The management roles responsible, and how oversight is exercised over them.',1.00,'entered',NULL,2,2),
    ('s1-g3','S1','governance','S1 G3','Controls and procedures support the disclosures','The controls and procedures that make the sustainability disclosures reliable.',1.00,'entered',NULL,2,3),
    -- S1 · Strategy
    ('s1-s1','S1','strategy','S1 S1','Material sustainability risks and opportunities identified','Which sustainability-related risks and opportunities could reasonably affect prospects, and how materiality was judged.',1.50,'entered',NULL,2,1),
    ('s1-s2','S1','strategy','S1 S2','Effects on business model, strategy and financial position','The effects of those risks and opportunities, current and anticipated.',1.00,'entered',NULL,2,2),
    ('s1-s3','S1','strategy','S1 S3','Time horizons defined and applied consistently','How short, medium and long term are defined, and their consistency with planning horizons.',0.50,'entered',NULL,2,3),
    -- S1 · Risk management
    ('s1-r1','S1','risk','S1 R1','Process to identify, assess and prioritise sustainability risks','The process covering sustainability risks generally.',1.00,'entered',NULL,2,1),
    ('s1-r2','S1','risk','S1 R2','Integration with enterprise risk management','How that process sits inside the overall risk framework.',1.00,'entered',NULL,2,2),
    -- S1 · Metrics & targets, and the reporting mechanics S1 governs
    ('s1-m1','S1','metrics','S1 M1','Metrics disclosed for each material topic','A metric for each material sustainability topic, with its basis of preparation.',1.00,'entered',NULL,2,1),
    ('s1-m2','S1','metrics','S1 M2','Targets and progress for material topics','Targets set for material topics, and performance against them.',1.00,'entered',NULL,2,2),
    ('s1-m3','S1','metrics','S1 M3','Reporting boundary matches the financial statements','The sustainability disclosures cover the same reporting entity as the financial statements.',1.00,'entered',NULL,2,3),
    ('s1-m4','S1','metrics','S1 M4','Comparatives and restatement policy','Comparative information is given, and the policy for restating it is disclosed.',1.00,'entered',NULL,2,4),
    ('s1-m5','S1','metrics','S1 M5','Connected information','The links between the sustainability disclosures and the financial statements are explained.',1.00,'entered',NULL,2,5),
    ('s1-m6','S1','metrics','S1 M6','Statement of compliance with UK SRS','An explicit statement of compliance, where compliance is claimed.',1.00,'entered',NULL,2,6),
    ('s1-m7','S1','metrics','S1 M7','Judgements, uncertainties and estimates disclosed','The significant judgements made, and the measurement uncertainties behind the figures.',1.00,'entered',NULL,2,7),
    ('s1-m8','S1','metrics','S1 M8','Reporting timed with the financial report','Sustainability disclosures are published at the same time as the related financial statements.',0.50,'entered',NULL,2,8)
  ) AS v(requirement_id, standard_key, pillar_key, code, title, help_text, weight, source, nzi_source_key, target_maturity, ordering);

COMMIT;
