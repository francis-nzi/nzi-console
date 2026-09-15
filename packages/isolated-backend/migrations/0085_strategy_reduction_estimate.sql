-- 0085 — What a strategy is expected to save, as an estimate that says it is one.
--
-- The plan has been qualitative since `0075`: statuses and percentages of *progress*, never
-- carbon. This adds the first quantitative layer — a consultant's expected annual reduction
-- per strategy — so the plan can be rolled up into a **projected** trajectory and set against
-- the target pathway and the measured actuals.
--
-- **An estimate is not a measurement, and the schema says so.** These columns never touch
-- `reviewed_crp_snapshots`, and nothing derived from them may be presented as the assured
-- footprint. `estimate_assumptions` is mandatory alongside a figure for the same reason the
-- library's `modelled_impact_basis` is: a reduction number with no stated basis is the kind
-- of thing that ends up quoted in a client document as though it were measured.
--
-- **On `client_strategies`, not a child table.** The estimate is an attribute of the strategy
-- as it stands, and the strategy is already versioned, audited and history-tracked. A child
-- table would add a second notion of "current" for no gain.
--
-- **The library default is not added here** — it already exists. `reduction_strategies`
-- carries `modelled_tco2e_per_year` + `modelled_impact_basis` from `0075`, constrained to
-- travel together. A client estimate seeds from it and records that it did.
--
-- No capability change: entering an estimate is managing a client strategy, which is
-- `strategy.manage` — already held by Admin and Consultant. The matrix stays at version 3.

BEGIN;

ALTER TABLE nzi_console.client_strategies
  /* What the consultant entered, in the unit they entered it in. */
  ADD COLUMN estimate_amount numeric(14,3),
  ADD COLUMN estimate_unit text
    CHECK (estimate_unit IS NULL OR estimate_unit IN ('tco2e_per_year','percent')),
  /* Which scope the reduction lands on. A percent resolves against THIS scope's share of
     the benchmark in force, so the scope is what makes a percent mean anything. */
  ADD COLUMN estimate_scope text
    CHECK (estimate_scope IS NULL OR estimate_scope IN ('1','2','3')),
  /* The resolved figure the roll-up sums. Stored rather than recomputed on read so a
     changed benchmark cannot silently restate what a consultant agreed — the same reason
     targets stamp the benchmark they were set against (NZC-072). */
  ADD COLUMN estimate_tco2e_per_year numeric(14,3),
  ADD COLUMN estimate_assumptions text NOT NULL DEFAULT '',
  ADD COLUMN estimate_confidence text
    CHECK (estimate_confidence IS NULL OR estimate_confidence IN ('low','medium','high')),
  /* Where the number came from: seeded from the catalogue, or the consultant's own. */
  ADD COLUMN estimate_source text
    CHECK (estimate_source IS NULL OR estimate_source IN ('library-default','consultant')),
  /* The library version the seed came from, so "seeded from v3" stays true after v4. */
  ADD COLUMN estimate_source_version integer
    CHECK (estimate_source_version IS NULL OR estimate_source_version > 0),

  /* An estimate is all of its parts or none of them. A figure without a unit is unreadable,
     without a scope a percent is meaningless, without assumptions it is an unsourced claim,
     and without provenance nobody can tell a catalogue seed from a consultant's judgement. */
  ADD CONSTRAINT client_strategies_estimate_complete CHECK (
    estimate_amount IS NULL
    OR (estimate_unit IS NOT NULL
        AND estimate_scope IS NOT NULL
        AND estimate_tco2e_per_year IS NOT NULL
        AND nullif(trim(estimate_assumptions), '') IS NOT NULL
        AND estimate_source IS NOT NULL)
  ),
  /* A reduction is a reduction: negative would be an increase wearing the wrong name, and
     the roll-up would quietly subtract it from the saving. */
  ADD CONSTRAINT client_strategies_estimate_non_negative CHECK (
    (estimate_amount IS NULL OR estimate_amount >= 0)
    AND (estimate_tco2e_per_year IS NULL OR estimate_tco2e_per_year >= 0)
  ),
  /* A percent of a baseline above 100 is not an estimate, it is an error. */
  ADD CONSTRAINT client_strategies_estimate_percent_bounded CHECK (
    estimate_unit IS DISTINCT FROM 'percent' OR estimate_amount <= 100
  ),
  /* Only a seed cites a library version. */
  ADD CONSTRAINT client_strategies_estimate_seed_versioned CHECK (
    estimate_source_version IS NULL OR estimate_source = 'library-default'
  );

COMMENT ON COLUMN nzi_console.client_strategies.estimate_tco2e_per_year IS
  'The consultant''s ESTIMATED annual reduction, resolved to tCO2e/yr. A forward estimate and never a measurement: it is not derived from an assured snapshot and must never be rendered as the assured footprint.';
COMMENT ON COLUMN nzi_console.client_strategies.estimate_assumptions IS
  'What the estimate rests on. Mandatory alongside a figure: an unsourced reduction number is what ends up quoted as though it were measured.';
COMMENT ON COLUMN nzi_console.client_strategies.estimate_source IS
  'library-default = seeded from the catalogue''s modelled impact (with estimate_source_version); consultant = entered or overridden by hand.';

COMMIT;
