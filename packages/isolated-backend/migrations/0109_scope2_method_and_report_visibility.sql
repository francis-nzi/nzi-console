-- 0109 Which Scope 2 method a row was measured by, and whether it appears in the report (NZC-143).
--
-- ## Why a read needed a migration
--
-- The live emissions aggregation is a derived read: it sums each row's own resolved tCO2e and stores
-- nothing. But the rule it has to apply — **the headline is location-based, and market-based rows are
-- never summed into it** — has had nothing to read. No column anywhere said which method a row was
-- measured by, so "exclude market" would have excluded nothing and the rule would have passed over an
-- empty set for as long as nobody looked.
--
-- So the read is net-new and these two columns are what make its rule mean something.
--
-- ## `scope2_method` is Scope 2 only, deliberately
--
-- Location-versus-market is a Scope 2 concept: it exists because purchased energy can be accounted for
-- by what the grid actually emitted or by what the contract says was bought. There is no equivalent
-- question for Scope 1 or Scope 3, so a general `accounting_method` column would be a field with no rule
-- behind it for every other row — an attractive nuisance that would eventually be filled in with
-- something, and then read.
--
-- `scope` on this table holds the canonical CRP code, which is `'1'`, `'2'`, or `'3.1'`–`'3.15'`.
-- Scope 2 is the single value `'2'`: electricity, heat, steam and cooling all sit under it and are
-- distinguished by `category_code`, so one CHECK on `scope = '2'` covers all of purchased energy rather
-- than only electricity.
--
-- ## Null on a Scope 2 row means location, and that direction is chosen
--
-- The constraint permits a Scope 2 row with no method, because every row written before today has none
-- and a backfill would be inventing a fact. The aggregation therefore excludes only what is *explicitly*
-- market: null counts toward the total.
--
-- That is the safe direction, and it is the reason for choosing it. An unset method reading as location
-- means a missing declaration can only ever **over**-count the headline, never under-count it. The
-- opposite default would let a row quietly vanish from a client's total by omission, which is the
-- failure that matters here.
--
-- ## `show_in_report` cannot hide anything that counts
--
-- Every row carries it, defaulting to true, so the commit and the audit treat one column uniformly
-- rather than a special case that only some rows have. The CHECK is what makes it safe:
--
--   CHECK (show_in_report = true OR scope2_method = 'market')
--
-- It can only ever be false on a market-based row. A location row or a Scope 1/3 row being hidden —
-- which would silently undercount what is reported — is **unrepresentable**, not merely discouraged.
-- Market rows contribute 0 to every total anyway, so this toggle governs presentation only and can never
-- move a number.

BEGIN;

ALTER TABLE nzi_console.job_scope_rows
  ADD COLUMN scope2_method text,
  ADD COLUMN show_in_report boolean NOT NULL DEFAULT true;

ALTER TABLE nzi_console.job_scope_rows
  ADD CONSTRAINT job_scope_rows_scope2_method_values
    CHECK (scope2_method IS NULL OR scope2_method IN ('location', 'market')),
  ADD CONSTRAINT job_scope_rows_scope2_method_is_scope2_only
    CHECK (scope2_method IS NULL OR scope = '2'),
  -- False only on a market row. This is the constraint that makes "hidden" unable to mean "uncounted".
  --
  -- `COALESCE` rather than a bare `scope2_method = 'market'`, and the difference is the whole constraint:
  -- on a Scope 1 row the method is null, so `false OR (null = 'market')` evaluates to **null**, and a CHECK
  -- admits null. Written the obvious way this rejected a Scope 2 location row and quietly allowed every
  -- Scope 1 and Scope 3 row to be hidden — the exact undercount it was added to prevent. Found by the test
  -- that asserts the refusal rather than by reading it back.
  ADD CONSTRAINT job_scope_rows_hidden_rows_are_market_only
    CHECK (show_in_report = true OR COALESCE(scope2_method, '') = 'market');

COMMENT ON COLUMN nzi_console.job_scope_rows.scope2_method IS
  'location or market, for Scope 2 rows only (electricity, heat, steam, cooling — all scope = ''2''). Null is permitted and reads as location: rows written before this column existed have none, and treating an unset method as location means a missing declaration can only over-count the headline, never under-count it.';

COMMENT ON COLUMN nzi_console.job_scope_rows.show_in_report IS
  'Whether the row appears in the report. Constrained so it can only be false on a market-based row, which contributes 0 to every total in any case — so this governs presentation and can never move a number. Hiding a row that counts is unrepresentable rather than merely discouraged.';

-- The aggregation reads by job, then narrows by site, scope and category. One index for the shape the
-- summary strip, the scope bands and the category title bars all read through.
CREATE INDEX job_scope_rows_emissions_rollup_idx
  ON nzi_console.job_scope_rows(organisation_id, job_id, scope, category_code)
  WHERE enabled = true;

COMMIT;
