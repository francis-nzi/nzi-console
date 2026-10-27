-- 0190 Actions A3: a reminder to an action's owner before its target date, through the email pipe that already exists
-- (BUILD-actions-A3-due-date-reminders, R1–R8).
--
-- ## What is added
--
-- - **The Admin settings** (R6): `organisation_reminder_settings` — the on/off master and the default lead (7 days). No row
--   reads as **off**, lead 7: reminders write to clients, so they start only when an admin turns them on.
-- - **The per-action lead** (R1): `client_strategies.reminder_lead_days` — null takes the organisation's default.
-- - **The sent-marker** (R4): `strategy_due_reminders`, one row per reminder enqueued. Its unique key is (action, due date):
--   the scan and the enqueue are one transaction, so winning that insert is how a tick earns the send, and a re-tick for the
--   same date finds the row and sends nothing. A **changed** date is a new key, so the reminder re-arms. A row names the
--   owner by contact id and the email by its `email_messages` id — never the address (R7).
--
-- ## What the worker may now read, and why (R2)
--
-- The reminder is rendered in the worker, in the house frame (5-1) and signed by the client's adviser (5-2), by the same
-- `sendTemplatedEmail` every other templated send uses. That render reads the organisation's branding and the adviser's
-- signature, which `nzi_console_worker` has never been able to see. It is granted **those columns only**:
--
-- - `organisation_profiles`: the six brand fields `emailBrandFor` uses. Not the registration, VAT, address or contact
--   details — the profile's other columns stay closed to the worker.
-- - `memberships`: the fields `emailPersonForMember` reads to sign as a member (name, work email, status, position, the
--   0185 signature lines). Not credentials, not roles, not the sealed copies.
-- - `reference_values`: the position label a title defaults to.
--
-- The worker still runs as itself: it is not given the console's role, which could edit the plan it is reminding about.
--
-- Nothing is deleted from here: a reminder enqueued is a fact about what a client was sent.

BEGIN;

-- ── The Admin settings (R6) ──────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE nzi_console.organisation_reminder_settings (
  organisation_id text PRIMARY KEY REFERENCES nzi_console.organisations(organisation_id),
  enabled boolean NOT NULL DEFAULT false,
  default_lead_days smallint NOT NULL DEFAULT 7 CHECK (default_lead_days BETWEEN 0 AND 90),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL
);
COMMENT ON TABLE nzi_console.organisation_reminder_settings IS
  'A3: the reminder master switch and default lead, edited in Admin beside the message templates. No row: off, 7 days.';

ALTER TABLE nzi_console.organisation_reminder_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.organisation_reminder_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.organisation_reminder_settings
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.organisation_reminder_settings TO nzi_console_app;
GRANT SELECT ON nzi_console.organisation_reminder_settings TO nzi_console_worker;

-- ── The per-action lead (R1) ─────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE nzi_console.client_strategies
  ADD COLUMN reminder_lead_days smallint CHECK (reminder_lead_days IS NULL OR reminder_lead_days BETWEEN 0 AND 90);
COMMENT ON COLUMN nzi_console.client_strategies.reminder_lead_days IS
  'A3: days before the target date that the owner is reminded. Null: the organisation''s default lead.';

-- ── The sent-marker (R4) ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE nzi_console.strategy_due_reminders (
  organisation_id text NOT NULL,
  reminder_id text NOT NULL,
  client_strategy_id text NOT NULL,
  client_id text NOT NULL,
  -- The target date the reminder was about, as it stood when it was enqueued. Part of the key: a moved date re-arms.
  due_date date NOT NULL,
  lead_days smallint NOT NULL CHECK (lead_days BETWEEN 0 AND 90),
  owner_contact_id text NOT NULL,
  template_code text NOT NULL,
  email_message_id text NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, reminder_id),
  FOREIGN KEY (organisation_id, client_strategy_id) REFERENCES nzi_console.client_strategies(organisation_id, client_strategy_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id),
  FOREIGN KEY (organisation_id, email_message_id) REFERENCES nzi_console.email_messages(organisation_id, email_message_id)
);
-- The idempotency key: once per action per due date, for all time.
CREATE UNIQUE INDEX strategy_due_reminders_once_idx ON nzi_console.strategy_due_reminders (organisation_id, client_strategy_id, due_date);
COMMENT ON TABLE nzi_console.strategy_due_reminders IS
  'A3: one row per due-date reminder enqueued. (action, due date) is unique, so a re-tick never re-sends and a moved date re-arms. Recipient by contact id, the email by id — never the address.';

ALTER TABLE nzi_console.strategy_due_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.strategy_due_reminders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.strategy_due_reminders
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT ON nzi_console.strategy_due_reminders TO nzi_console_worker;
GRANT SELECT ON nzi_console.strategy_due_reminders TO nzi_console_app;
REVOKE UPDATE, DELETE ON nzi_console.strategy_due_reminders FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

-- ── What the render reads, column by column (R2) ─────────────────────────────────────────────────────────────────────
GRANT SELECT (organisation_id, legal_name, display_name, website_url, email_logo_url, email_badge_url, email_confidentiality_notice)
  ON nzi_console.organisation_profiles TO nzi_console_worker;
GRANT SELECT (organisation_id, user_id, display_name, email, status, version, position_value_id,
              signature_title, signature_email, signature_mobile, signature_sign_off)
  ON nzi_console.memberships TO nzi_console_worker;
GRANT SELECT (organisation_id, value_id, label) ON nzi_console.reference_values TO nzi_console_worker;

-- Everything the A3 scan touches, asserted — a gap fails here, not on every tick (the 0183 lesson).
DO $$
DECLARE
  needed record;
  missing text[] := '{}';
BEGIN
  FOR needed IN SELECT * FROM (VALUES
    ('organisation_reminder_settings', 'SELECT'), ('client_strategies', 'SELECT'), ('clients', 'SELECT'),
    ('client_contacts', 'SELECT'), ('message_templates', 'SELECT'),
    ('strategy_due_reminders', 'SELECT'), ('strategy_due_reminders', 'INSERT'),
    ('email_messages', 'INSERT'), ('transactional_outbox', 'INSERT'), ('audit_events', 'INSERT')
  ) AS t(table_name, privilege) LOOP
    IF NOT has_table_privilege('nzi_console_worker', format('nzi_console.%I', needed.table_name), needed.privilege) THEN
      missing := missing || format('%s on %s', needed.privilege, needed.table_name);
    END IF;
  END LOOP;
  IF has_table_privilege('nzi_console_worker', 'nzi_console.organisation_profiles', 'SELECT')
     OR has_table_privilege('nzi_console_worker', 'nzi_console.memberships', 'SELECT') THEN
    missing := missing || 'a whole-table read where only columns were meant'::text;
  END IF;
  IF has_column_privilege('nzi_console_worker', 'nzi_console.organisation_profiles', 'vat_number', 'SELECT') THEN
    missing := missing || 'the profile''s non-brand columns are readable'::text;
  END IF;
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION '0190: nzi_console_worker is not granted as A3 needs: %', array_to_string(missing, ', ');
  END IF;
END $$;

COMMIT;
