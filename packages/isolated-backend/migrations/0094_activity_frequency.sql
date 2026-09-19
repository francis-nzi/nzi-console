-- 0094 An entry records the grain it was supplied at, and whether its months were derived (NZC-107).
--
-- Month-grain storage has existed since 0031 (`job_scope_rows.monthly_activity_json`) and 0036
-- (`job_emission_sources.monthly_activity_json`), but nothing has ever recorded *how* those months
-- came to be filled. A consultant handed one annual invoice and a consultant handed twelve meter
-- reads produce vectors that are byte-for-byte indistinguishable once stored — and they are not the
-- same claim about the world. One is measured; the other is a year's figure spread across months
-- nobody measured separately.
--
-- ## Why this is not the client's reporting frequency
--
-- `clients.data_reporting_frequency` (0060) already exists and shares this vocabulary. It is a
-- different thing at a different grain: the cadence the *engagement* agreed to report on, a
-- property of the client. These two columns are the basis on which *this particular figure* was
-- supplied, a property of the entry. The client's setting is the default offered when an entry is
-- captured; it is read at that moment and stored here. Changing the client's cadence later never
-- reaches back and rewrites what a stored entry claims about itself.
--
-- The shared vocabulary is deliberate — annual, quarterly and monthly mean the same three things in
-- both places. What was missing was the stated relationship, which is the paragraph above.
--
-- ## Nullable, and deliberately not backfilled
--
-- Every existing row keeps a null `activity_frequency`. A backfill would have to guess: a row with
-- twelve populated months was *probably* captured monthly, and a row with an annual quantity and no
-- vector was *probably* annual — but "probably" written into a provenance column stops being a
-- guess the moment anything reads it. Null says "not recorded", which is true, and which a read can
-- present honestly. The same reasoning as 0091's unbackfilled reporting period.
--
-- `activity_distributed` is the exception, and only because its backfill is a fact rather than a
-- guess: nothing before this migration could distribute anything, so `false` is not an assumption
-- about existing rows — it is a statement about the code that wrote them.
--
-- ## Why a separate flag rather than a fifth quality tier
--
-- `quality_tier` (0008) is the documented data-quality taxonomy — measured, estimated, spend-based,
-- survey — and it travels with every measurement and every chart. Distribution is orthogonal to it:
-- a spend-based figure can be distributed, and so can a measured one. Adding "distributed" to that
-- enum would overload a tier that already means something else, and would make a distributed
-- measured reading indistinguishable from an estimate.

BEGIN;

ALTER TABLE nzi_console.job_scope_rows
  ADD COLUMN activity_frequency text
    CHECK (activity_frequency IS NULL OR activity_frequency IN ('annual','quarterly','monthly')),
  ADD COLUMN activity_distributed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN nzi_console.job_scope_rows.activity_frequency IS
  'The grain this row''s activity was supplied at (annual | quarterly | monthly) — a property of the entry, defaulted at capture from the client''s data_reporting_frequency and stored, never read back through. Null on rows recorded before 0094, which is "not recorded" rather than a guess.';
COMMENT ON COLUMN nzi_console.job_scope_rows.activity_distributed IS
  'Whether the monthly vector was derived by spreading a coarser figure rather than supplied month by month. Orthogonal to quality_tier (0008): a measured figure can be distributed and so can a spend-based one.';

ALTER TABLE nzi_console.job_emission_sources
  ADD COLUMN activity_frequency text
    CHECK (activity_frequency IS NULL OR activity_frequency IN ('annual','quarterly','monthly')),
  ADD COLUMN activity_distributed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN nzi_console.job_emission_sources.activity_frequency IS
  'The grain this source''s activity was supplied at. Same meaning, same values and same mechanism as job_scope_rows.activity_frequency — one shared implementation serves both stores so the register and the canonical row cannot disagree.';
COMMENT ON COLUMN nzi_console.job_emission_sources.activity_distributed IS
  'Whether this source''s monthly vector was derived by spreading a coarser figure. See job_scope_rows.activity_distributed.';

-- A distributed vector is a claim that months were derived, which is only meaningful about a figure
-- supplied at a coarser grain than the month. A row cannot say it was captured month by month and
-- distributed at the same time.
ALTER TABLE nzi_console.job_scope_rows
  ADD CONSTRAINT job_scope_rows_distribution_grain
    CHECK (activity_distributed = false OR activity_frequency IN ('annual','quarterly'));
ALTER TABLE nzi_console.job_emission_sources
  ADD CONSTRAINT job_emission_sources_distribution_grain
    CHECK (activity_distributed = false OR activity_frequency IN ('annual','quarterly'));

COMMIT;
