-- 0141 Team & access (admin Phase B, B1; ruled plan `phaseB-team-access-plan.md`, Q1–Q11 and R9 = option (c)).
--
-- ## What it adds
--
-- 1. **The roster is `memberships`** (Q1) — not a second staff table. A membership is already the actor identity:
--    the session resolves it, `audit_events.actor_id` records it, and five tables point at it. It gains what an
--    admin screen needs to govern it:
--    - `version`, which every membership write bumps and every command checks (`expectedVersion`);
--    - `position_value_id`, the person's position in the governed `positions` lookup (A3 imported v7's four);
--    - the status **`deactivated`**, with who and when. `invited` and `suspended` stay allowed and unused;
--    - `source_system` and `legacy_values` — v7 provenance for the B2 import. **No `legacy_db_id`**: v7's user id
--      *is* the email address, so the import's identity is `(organisation_id, email_bidx)`, the blind index the
--      address already has, and no plaintext address is ever written beside the sealed one. `legacy_values` holds
--      only v7's role, status, archived flag and position label — nothing personal;
--    - `updated_at` / `updated_by`.
--    The name and email are unchanged: plaintext beside ciphertext, sealed in the same transaction (NZC-119).
-- 2. **Never deleted, by construction** (R3): the application and worker roles lose DELETE on `memberships`. 0002's
--    blanket grant had left it, guarded only by the foreign keys of referenced rows.
-- 3. **Never locked out, by construction** (Q2): a deferred constraint trigger refuses any change that takes the
--    organisation's last active admin away — demotion, deactivation, or deletion by any role that still could. It
--    locks the organisation's active admin rows before it counts, so two concurrent demotions cannot each see the
--    other's admin and both pass. It guards the transition, not the state: an organisation with no admin yet (a new
--    one, or a fixture) is not refused, and the first admin can still be made.
-- 4. **`staff_rates`** (R9 = option (c)) — a person's hourly cost and sell rate, effective-dated and append-only:
--    a change from a later date is a new row; a correction is a new row that **supersedes** the one it corrects
--    (never an edit in place). Commercially sensitive, not personal data: per-organisation under forced row-level
--    security, and read or written only with `finance.manage` (the command and the read check it — `finance.view`
--    also reaches Consultant, so it is the wrong gate). Matrix v8 already grants `finance.manage` to Admin and
--    Finance (0131), so there is **no matrix bump**. Ships empty.

BEGIN;

-- ── memberships ─────────────────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE nzi_console.memberships
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN position_value_id text,
  ADD COLUMN deactivated_at timestamptz,
  ADD COLUMN deactivated_by text,
  ADD COLUMN source_system text,
  ADD COLUMN legacy_values jsonb,
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by text;

-- Mirrors clients_sector_reference_fk (0090): the value is this organisation's; the command checks its category.
ALTER TABLE nzi_console.memberships
  ADD CONSTRAINT memberships_position_reference_fk
    FOREIGN KEY (organisation_id, position_value_id) REFERENCES nzi_console.reference_values (organisation_id, value_id);

ALTER TABLE nzi_console.memberships DROP CONSTRAINT memberships_status_check;
ALTER TABLE nzi_console.memberships
  ADD CONSTRAINT memberships_status_check CHECK (status IN ('active', 'invited', 'suspended', 'deactivated')),
  -- Deactivated exactly when it says who did it and when; reinstating clears both.
  ADD CONSTRAINT memberships_deactivation_shape CHECK (
    (status = 'deactivated') = (deactivated_at IS NOT NULL AND deactivated_by IS NOT NULL AND btrim(deactivated_by) <> '')),
  ADD CONSTRAINT memberships_import_provenance_shape CHECK (
    (source_system IS NULL AND legacy_values IS NULL)
    OR (source_system = 'nzi-pro-v7' AND legacy_values IS NOT NULL AND jsonb_typeof(legacy_values) = 'object'));

CREATE INDEX memberships_position_idx ON nzi_console.memberships (organisation_id, position_value_id) WHERE position_value_id IS NOT NULL;

COMMENT ON COLUMN nzi_console.memberships.legacy_values IS
  'What v7 held for this person when last imported — role, status, archived flag and position label. Never a name or an address: those are sealed columns, and this one is not.';

-- Never deleted (R3): deactivate instead. The owner keeps DELETE for a migration that needs it.
REVOKE DELETE ON nzi_console.memberships FROM nzi_console_app, nzi_console_worker;

-- ── The last active admin (Q2) ──────────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION nzi_console.memberships_keep_an_admin() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, nzi_console AS $$
DECLARE
  remaining integer;
BEGIN
  -- Only a row that WAS an active admin can take the last one away.
  IF NOT (OLD.role_id = 'admin' AND OLD.status = 'active') THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.role_id = 'admin' AND NEW.status = 'active' AND NEW.organisation_id = OLD.organisation_id THEN
    RETURN NULL;
  END IF;
  -- Lock before counting: a concurrent demotion's row is waited for and then re-read, so it cannot be counted as
  -- still an admin once it has committed as something else.
  SELECT count(*) INTO remaining FROM (
    SELECT 1 FROM nzi_console.memberships
     WHERE organisation_id = OLD.organisation_id AND role_id = 'admin' AND status = 'active'
     FOR UPDATE) AS admins;
  IF remaining = 0 THEN
    RAISE EXCEPTION 'LAST_ADMIN: % would be left with no active admin', OLD.organisation_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'memberships_keep_an_admin';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER memberships_keep_an_admin
  AFTER UPDATE OR DELETE ON nzi_console.memberships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nzi_console.memberships_keep_an_admin();

COMMENT ON TRIGGER memberships_keep_an_admin ON nzi_console.memberships IS
  'Never lock an organisation out: at commit, a change that took an active admin away must leave another. Guards the transition, so an organisation that has not yet had an admin can still be given one.';

-- ── staff_rates (R9 = option (c)) ───────────────────────────────────────────────────────────────────────────────

CREATE TABLE nzi_console.staff_rates (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  rate_id text NOT NULL,
  user_id text NOT NULL,
  effective_from date NOT NULL,
  cost_per_hour numeric(12,2) CHECK (cost_per_hour >= 0),
  sell_per_hour numeric(12,2) CHECK (sell_per_hour >= 0),
  currency text NOT NULL DEFAULT 'GBP' CHECK (currency ~ '^[A-Z]{3}$'),
  -- The row this one corrects. A row is corrected at most once; the correction is the row that counts.
  supersedes_rate_id text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by text NOT NULL CHECK (btrim(recorded_by) <> ''),
  PRIMARY KEY (organisation_id, rate_id),
  FOREIGN KEY (organisation_id, user_id) REFERENCES nzi_console.memberships (organisation_id, user_id),
  FOREIGN KEY (organisation_id, supersedes_rate_id) REFERENCES nzi_console.staff_rates (organisation_id, rate_id),
  CONSTRAINT staff_rates_supersede_once UNIQUE (organisation_id, supersedes_rate_id),
  CONSTRAINT staff_rates_not_self CHECK (supersedes_rate_id IS DISTINCT FROM rate_id),
  CONSTRAINT staff_rates_says_something CHECK (cost_per_hour IS NOT NULL OR sell_per_hour IS NOT NULL)
);

CREATE INDEX staff_rates_person_idx ON nzi_console.staff_rates (organisation_id, user_id, effective_from DESC);

COMMENT ON TABLE nzi_console.staff_rates IS
  'A person''s hourly cost and sell rate from a date, append-only. A later date is a new row; a correction is a new row naming the one it supersedes. The rate in force on a day is the live (unsuperseded) row with the latest effective_from on or before it. Read and written with finance.manage only.';

-- One live rate per person per date, and a correction corrects that person's live row.
CREATE FUNCTION nzi_console.staff_rates_supersede_rule() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, nzi_console AS $$
DECLARE
  corrected nzi_console.staff_rates;
  clash text;
BEGIN
  -- One writer per person at a time, so two inserts for the same date cannot both find the date free. An advisory lock,
  -- not a row lock: the table is append-only, and a row lock needs the UPDATE privilege nobody holds.
  PERFORM pg_advisory_xact_lock(hashtextextended('staff_rates:' || NEW.organisation_id || ':' || NEW.user_id, 0));
  IF NEW.supersedes_rate_id IS NOT NULL THEN
    SELECT * INTO corrected FROM nzi_console.staff_rates
     WHERE organisation_id = NEW.organisation_id AND rate_id = NEW.supersedes_rate_id;
    IF corrected.user_id IS DISTINCT FROM NEW.user_id THEN
      RAISE EXCEPTION 'A rate can only correct a rate of the same person.' USING ERRCODE = 'check_violation', CONSTRAINT = 'staff_rates_supersede_rule';
    END IF;
  END IF;
  SELECT r.rate_id INTO clash FROM nzi_console.staff_rates r
   WHERE r.organisation_id = NEW.organisation_id AND r.user_id = NEW.user_id AND r.effective_from = NEW.effective_from
     AND r.rate_id IS DISTINCT FROM NEW.supersedes_rate_id
     AND NOT EXISTS (SELECT 1 FROM nzi_console.staff_rates s WHERE s.organisation_id = r.organisation_id AND s.supersedes_rate_id = r.rate_id)
   LIMIT 1;
  IF clash IS NOT NULL THEN
    RAISE EXCEPTION 'A rate from % already stands for this person; correct it instead.', NEW.effective_from
      USING ERRCODE = 'check_violation', CONSTRAINT = 'staff_rates_supersede_rule';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER staff_rates_supersede_rule BEFORE INSERT ON nzi_console.staff_rates
  FOR EACH ROW EXECUTE FUNCTION nzi_console.staff_rates_supersede_rule();

ALTER TABLE nzi_console.staff_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.staff_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.staff_rates
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
REVOKE ALL ON nzi_console.staff_rates FROM PUBLIC;
-- Append-only: history by superseding rows, never an edit or a delete.
GRANT SELECT, INSERT ON nzi_console.staff_rates TO nzi_console_app;

COMMIT;
