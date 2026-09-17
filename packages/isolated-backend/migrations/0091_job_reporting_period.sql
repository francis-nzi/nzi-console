-- 0091 A job records the period it reports on, and who manages it (NZC-092).
--
-- Part 1 of the jobs redesign gives the create form four dates — job start, job end, reporting
-- period start, reporting period end — where it had two. The first two already have columns
-- (`start_date`, `due_date`, added in 0004). The period the job reports on has never been stored
-- at all: only `reporting_year`, an integer, derived at create time from the start date.
--
-- ## Why the period has to be stored, not inferred
--
-- `reporting_year` alone cannot answer "which period is this?" for any client whose financial year
-- does not end in December. FY2024 for a March year end is 01/04/2024–31/03/2025, and four places
-- in this codebase reconstruct that from the year plus the client's `financial_year_end_month`
-- (see the characterisation test pinned in #210). That reconstruction is correct only while every
-- job's period is exactly the client's financial year. It stops being correct the moment a
-- consultant enters a period that is not — a part-year first engagement, a transition period after
-- a year-end change, a client reporting on a different basis from its statutory accounts.
--
-- Storing the two dates the consultant actually entered means the period is recorded rather than
-- recomputed, and `reporting_year` becomes a label on it instead of the only evidence of it.
--
-- ## Nullable, and deliberately not backfilled
--
-- Every existing job keeps a null period. This is the forward-derive-only instruction from #210
-- made physical: the stored `reporting_year` of an existing job means what it meant when it was
-- written — the year the period *started* — and Part 1's new rule labels a period by the year it
-- *ends*. Those two rules disagree by exactly one year for every non-December year end.
--
-- So a backfill computing a period from an existing `reporting_year` would be inventing dates
-- under one convention that would then be read back under the other, silently moving FY24 to FY25
-- for a March year end. A null period says "not recorded", which is true, and which every read can
-- handle honestly. Nothing here reaches backwards.
--
-- ## The client manager, and why there is no new text column
--
-- The job form replaces its free-text "Owner" with the client manager, defaulted from the client's
-- own (0090) and changeable per job. That needs a reference, so `client_manager_user_id` arrives
-- with the same membership foreign key 0090 gave `clients`.
--
-- It arrives **alone**. The NZC-090 pattern is an id beside the text that was typed when there was
-- no list to choose from, and on `jobs` that text already exists: `owner_name` is precisely a name
-- typed against nothing. Adding a `client_manager_name` beside it would create a second column
-- meaning the same thing, and two columns meaning the same thing drift. The resolver reads the id
-- first and falls back to `owner_name`, so historical jobs keep showing the person they named.
--
-- The column keeps its historical name because renaming it is neither trivial nor safe — it is
-- read by the jobs list, the read models, the report compositions and the mock fixtures. The name
-- is a fact about when it was added, not a claim about what it means today.

BEGIN;

ALTER TABLE nzi_console.jobs
  ADD COLUMN reporting_period_start date,
  ADD COLUMN reporting_period_end date,
  ADD COLUMN client_manager_user_id text;

-- A period that ends before it starts is not a period. The database says so, because the server
-- validator can be bypassed by a future writer and this cannot.
ALTER TABLE nzi_console.jobs
  ADD CONSTRAINT jobs_reporting_period_ordered
    CHECK (reporting_period_start IS NULL OR reporting_period_end IS NULL
           OR reporting_period_start < reporting_period_end),
  -- Mirrors clients_manager_membership_fk (0090): a client manager is a member of this
  -- organisation, and the database says so rather than the application remembering to.
  ADD CONSTRAINT jobs_manager_membership_fk
    FOREIGN KEY (organisation_id, client_manager_user_id)
    REFERENCES nzi_console.memberships (organisation_id, user_id);

CREATE INDEX jobs_manager_idx ON nzi_console.jobs (organisation_id, client_manager_user_id)
  WHERE client_manager_user_id IS NOT NULL;

COMMIT;
