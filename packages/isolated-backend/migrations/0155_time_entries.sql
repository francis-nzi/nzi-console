-- 0155 Time (TIME-module kickoff; rulings T-Q1…T-Q7 and `TIME-v7-RULINGS.md` ⚑1–⚑9 + Addendum): staff log their own
-- time against jobs, and jobs carry the budget and fee that time is compared with.
--
-- ## What it adds
--
-- 1. **`activity_types`** — a Lookups category (Admin → Lookups), seeded per organisation with Fieldwork, Analysis,
--    Reporting, Meeting, Travel and Admin (⚑3). v7's three subjects arrive later with the time import (⚑7).
-- 2. **`time_activity_defaults`** — the billable default of each activity value (Addendum): one row per value, a
--    NOT NULL `billable_default`, created with the value. Seeded: Travel and Admin non-billable, the rest billable.
--    A time entry's `billable` defaults from it and is overridable per entry.
-- 3. **`time_entries`** — one person's time on one job on one London `work_date`; **many a day** (⚑2), each with its
--    own activity, billable state and note.
--    - **`minutes`**, an integer, > 0 and ≤ 1440 (⚑1, ⚑9); the screen enters and shows quarter-hours.
--    - **`cost_rate` / `charge_rate`** snapshotted from the person's `staff_rates` row in force on the `work_date`
--      (T-Q1) — `rate_id` records which — so a later rate change never rewrites past cost. Null when no rate was in
--      force ("rate not recorded"), never invented.
--    - **`billed_ref`** null until invoiced (T-Q5); once set the entry is locked to all but finance (T-Q6).
--    - Versioned, voided (never deleted), 0132 provenance for the v7 import.
-- 4. **`memberships.weekly_capacity_hours`** (T-Q4), default 37.5, so utilisation can be read against capacity.
-- 5. **`jobs.budgeted_hours` and `jobs.fee_amount`** (⚑5 (a)): the job's own budget and fee (ex VAT). `fee_amount` is
--    money: read behind finance.view, set behind finance.manage, and never written into an audit, idempotency or
--    outbox payload (NZC-120). **Backfilled** here from each job's job type template — Σ default hours × quantity and
--    Σ default sell × quantity over the template's **included** items — and left null where a job has no template or
--    its items carry no hours / price (no budget recorded, never zero).
--    **Intent for later:** these are the job's stored budget and fee. When the commercial flow brings per-job line
--    items, a follow-up migration decides whether they become derived from those lines or stay the stored figure the
--    lines roll into — deliberately, not by drift.
--
-- Forced row-level security and the tenant policy on the two new tables; no DELETE for anyone. The capabilities
-- (`time.log`, `time.view`) are permission-matrix v9, 0156.

BEGIN;

-- ── 1. The activity lookup ─────────────────────────────────────────────────────────────────────────────────────────

INSERT INTO nzi_console.reference_categories (category_key, label, scope, description, carries_code, code_label) VALUES
  ('activity_types', 'Activity types', 'organisation', 'What time is logged as — fieldwork, reporting, travel… Each carries a billable default.', false, NULL);

-- ── 2. Each activity's billable default ────────────────────────────────────────────────────────────────────────────

CREATE TABLE nzi_console.time_activity_defaults (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  value_id text NOT NULL,
  billable_default boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),
  PRIMARY KEY (organisation_id, value_id),
  FOREIGN KEY (organisation_id, value_id) REFERENCES nzi_console.reference_values (organisation_id, value_id)
);
COMMENT ON TABLE nzi_console.time_activity_defaults IS
  'The billable default of each activity_types value (TIME Addendum): created with the value, changed through the Lookups commands, audited there.';
ALTER TABLE nzi_console.time_activity_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.time_activity_defaults FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.time_activity_defaults
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
REVOKE ALL ON nzi_console.time_activity_defaults FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON nzi_console.time_activity_defaults TO nzi_console_app;

-- ── 3. The seed, for every organisation and every new one (the 0145 pattern) ───────────────────────────────────────

CREATE FUNCTION nzi_console.provision_organisation_activity_types(p_organisation_id text, p_actor text) RETURNS integer
  LANGUAGE plpgsql SET search_path = pg_catalog, nzi_console AS $$
DECLARE
  added integer;
BEGIN
  -- `source` is left at its default with no source_system, which Lookups reads as "Seeded" (not "Added here").
  INSERT INTO nzi_console.reference_values (organisation_id, category_key, value_id, label, sort_order, created_by, updated_by)
  SELECT p_organisation_id, 'activity_types', 'activity_types:' || seed.slug, seed.label, seed.sort_order, p_actor, p_actor
    FROM (VALUES ('fieldwork', 'Fieldwork', 10), ('analysis', 'Analysis', 20), ('reporting', 'Reporting', 30),
                 ('meeting', 'Meeting', 40), ('travel', 'Travel', 50), ('admin', 'Admin', 60)) AS seed(slug, label, sort_order)
   WHERE NOT EXISTS (SELECT 1 FROM nzi_console.reference_values v
                      WHERE v.organisation_id = p_organisation_id AND v.category_key = 'activity_types' AND lower(v.label) = lower(seed.label))
  ON CONFLICT (organisation_id, value_id) DO NOTHING;
  GET DIAGNOSTICS added = ROW_COUNT;
  -- ⚑3: Travel and Admin default non-billable; every other activity billable.
  INSERT INTO nzi_console.time_activity_defaults (organisation_id, value_id, billable_default, created_by, updated_by)
  SELECT v.organisation_id, v.value_id, lower(v.label) NOT IN ('travel', 'admin'), p_actor, p_actor
    FROM nzi_console.reference_values v
   WHERE v.organisation_id = p_organisation_id AND v.category_key = 'activity_types'
  ON CONFLICT (organisation_id, value_id) DO NOTHING;
  RETURN added;
END;
$$;

DO $$
DECLARE
  org record;
  added integer;
BEGIN
  FOR org IN SELECT organisation_id FROM nzi_console.organisations ORDER BY organisation_id LOOP
    added := nzi_console.provision_organisation_activity_types(org.organisation_id, 'migration:0155');
    RAISE NOTICE '0155 activity types: organisation % · % seeded', org.organisation_id, added;
  END LOOP;
END;
$$;

CREATE FUNCTION nzi_console.provision_new_organisation_activity_types() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM nzi_console.provision_organisation_activity_types(NEW.organisation_id, 'migration:0155');
  RETURN NEW;
END;
$$;
CREATE TRIGGER provision_activity_types_on_insert AFTER INSERT ON nzi_console.organisations
  FOR EACH ROW EXECUTE FUNCTION nzi_console.provision_new_organisation_activity_types();

-- ── 4. Time entries ─────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE nzi_console.time_entries (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  entry_id text NOT NULL,
  user_id text NOT NULL,
  job_id text NOT NULL,
  work_date date NOT NULL,
  minutes integer NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
  activity_value_id text NOT NULL,
  billable boolean NOT NULL,
  note text CHECK (note IS NULL OR (btrim(note) <> '' AND length(note) <= 2000)),
  -- T-Q1: the rate snapshot, from the staff_rates row in force on work_date (rate_id), never the current one.
  rate_id text,
  cost_rate numeric(10, 2) CHECK (cost_rate IS NULL OR cost_rate >= 0),
  charge_rate numeric(10, 2) CHECK (charge_rate IS NULL OR charge_rate >= 0),
  rate_currency text CHECK (rate_currency IS NULL OR rate_currency ~ '^[A-Z]{3}$'),
  -- T-Q5 / T-Q6: null until invoiced; set, it locks the entry to all but finance.
  billed_ref text CHECK (billed_ref IS NULL OR btrim(billed_ref) <> ''),
  billed_at timestamptz,
  billed_by text,
  active boolean NOT NULL DEFAULT true,
  voided_at timestamptz,
  voided_by text,
  void_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),
  source_system text,
  legacy_db_id text,
  legacy_values jsonb,
  PRIMARY KEY (organisation_id, entry_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs (organisation_id, job_id),
  FOREIGN KEY (organisation_id, user_id) REFERENCES nzi_console.memberships (organisation_id, user_id),
  FOREIGN KEY (organisation_id, activity_value_id) REFERENCES nzi_console.reference_values (organisation_id, value_id),
  CONSTRAINT time_entries_rate_currency CHECK ((cost_rate IS NULL AND charge_rate IS NULL) OR rate_currency IS NOT NULL),
  CONSTRAINT time_entries_rate_source CHECK ((rate_id IS NULL) = (cost_rate IS NULL AND charge_rate IS NULL)),
  CONSTRAINT time_entries_billed_shape CHECK ((billed_ref IS NULL) = (billed_at IS NULL) AND (billed_ref IS NULL) = (billed_by IS NULL)),
  CONSTRAINT time_entries_void_shape CHECK (active = (voided_at IS NULL) AND (voided_at IS NULL) = (voided_by IS NULL)),
  CONSTRAINT time_entries_import_provenance_shape CHECK (
    (source_system IS NULL AND legacy_db_id IS NULL AND legacy_values IS NULL)
    OR (source_system IS NOT NULL AND btrim(source_system) <> '' AND legacy_db_id IS NOT NULL AND btrim(legacy_db_id) <> ''))
);
CREATE INDEX time_entries_person_idx ON nzi_console.time_entries (organisation_id, user_id, work_date DESC);
CREATE INDEX time_entries_job_idx ON nzi_console.time_entries (organisation_id, job_id, work_date DESC);
CREATE UNIQUE INDEX time_entries_legacy_idx ON nzi_console.time_entries (organisation_id, source_system, legacy_db_id) WHERE source_system IS NOT NULL;
COMMENT ON TABLE nzi_console.time_entries IS
  'Staff time against jobs (TIME module): minutes, many a day, rates snapshotted as of work_date, voided never deleted, locked once billed.';
ALTER TABLE nzi_console.time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.time_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.time_entries
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
REVOKE ALL ON nzi_console.time_entries FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON nzi_console.time_entries TO nzi_console_app;

-- ── 5. Capacity ─────────────────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE nzi_console.memberships
  ADD COLUMN weekly_capacity_hours numeric(5, 2) NOT NULL DEFAULT 37.5 CHECK (weekly_capacity_hours > 0 AND weekly_capacity_hours <= 168);

-- ── 6. The job's budget and fee, backfilled from its template ───────────────────────────────────────────────────

ALTER TABLE nzi_console.jobs
  ADD COLUMN budgeted_hours numeric(9, 2) CHECK (budgeted_hours IS NULL OR budgeted_hours >= 0),
  ADD COLUMN fee_amount numeric(12, 2) CHECK (fee_amount IS NULL OR fee_amount >= 0);
COMMENT ON COLUMN nzi_console.jobs.budgeted_hours IS
  'TIME ⚑5: the job''s budget in hours, defaulted from its template (Σ item default hours × quantity, included items). Null = no budget recorded.';
COMMENT ON COLUMN nzi_console.jobs.fee_amount IS
  'TIME ⚑5/⚑6: the job''s fee, ex VAT — money: finance-gated, never in an audit, idempotency or outbox payload (NZC-120). Null = no fee recorded.';

DO $$
DECLARE
  filled integer;
BEGIN
  WITH template AS (
    SELECT t.organisation_id, t.job_type_id,
           sum(i.default_hours * t.quantity) AS hours,
           sum(i.default_sell_amount * t.quantity) AS fee
      FROM nzi_console.job_type_items t
      JOIN nzi_console.job_items i ON (i.organisation_id, i.item_id) = (t.organisation_id, t.item_id)
     WHERE t.included
     GROUP BY t.organisation_id, t.job_type_id
  )
  UPDATE nzi_console.jobs j
     SET budgeted_hours = template.hours, fee_amount = template.fee
    FROM template
   WHERE (j.organisation_id, j.job_type_id) = (template.organisation_id, template.job_type_id)
     AND j.budgeted_hours IS NULL AND j.fee_amount IS NULL;
  GET DIAGNOSTICS filled = ROW_COUNT;
  RAISE NOTICE '0155 jobs: % backfilled from their job type template (budgeted hours and fee; null where the template has none)', filled;
END;
$$;

COMMIT;
