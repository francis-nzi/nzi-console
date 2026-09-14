BEGIN;

-- Reminder sends, and what makes them safe to retry.
--
-- The rule the whole channel rests on: **the log row is claimed before the send is
-- attempted, not written after it succeeds.** A row written afterwards cannot stop a
-- duplicate, because the crash that loses it happens between the send and the write. The
-- unique key below is therefore the idempotency key, and claiming it is how a worker earns
-- the right to send.
--
-- The key is (strategy, kind, target_date, recipient). Each part is load-bearing:
--   * `kind` — "approaching" and "overdue" are two different messages about one date, and
--     a client should get both.
--   * `target_date` — a date that MOVES is a new deadline and deserves a new reminder; a
--     date that has not moved never sends twice, however often the clock runs.
--   * `recipient_email` — two consenting contacts each get their own copy, and each is
--     tracked separately, because one bouncing must not silently cancel the other.

CREATE TABLE nzi_console.strategy_automation_log (
  organisation_id text NOT NULL,
  automation_log_id text NOT NULL,
  client_strategy_id text NOT NULL,
  client_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('approaching','overdue')),
  -- The deadline this reminder is about, as it stood when the reminder was claimed.
  target_date date NOT NULL,
  recipient_email text NOT NULL CHECK (recipient_email = lower(trim(recipient_email)) AND recipient_email <> ''),
  -- `claimed` is the in-flight state: the row exists, the send has not resolved. A worker
  -- that dies mid-send leaves this behind, and the retry rules below pick it up.
  -- `suppressed` is a successful outcome, not a failure: on a non-production environment
  -- the mail is composed and recorded but never put on the wire.
  state text NOT NULL DEFAULT 'claimed' CHECK (state IN ('claimed','sent','suppressed','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  -- What would have been sent, kept so a suppressed send is auditable rather than merely
  -- asserted. No secrets: subject and body only, never credentials or headers.
  subject text NOT NULL,
  body text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  PRIMARY KEY (organisation_id, automation_log_id),
  FOREIGN KEY (organisation_id, client_strategy_id)
    REFERENCES nzi_console.client_strategies(organisation_id, client_strategy_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id)
);

-- The idempotency key. One reminder per strategy, per kind, per deadline, per recipient —
-- for all time. This constraint is the guarantee; the worker's logic is only its servant.
CREATE UNIQUE INDEX strategy_automation_log_once_idx
  ON nzi_console.strategy_automation_log (organisation_id, client_strategy_id, kind, target_date, recipient_email);
CREATE INDEX strategy_automation_log_retry_idx
  ON nzi_console.strategy_automation_log (organisation_id, state, claimed_at);

COMMENT ON TABLE nzi_console.strategy_automation_log IS
  'Deadline reminders claimed, then resolved. The unique index is the idempotency key: a claim is taken before the send is attempted, so a re-run of the clock cannot double-send and a crash mid-send cannot lose the fact that a send was owed.';

ALTER TABLE nzi_console.strategy_automation_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.strategy_automation_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.strategy_automation_log
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

-- The worker claims, sends and resolves; it never deletes. A reminder that was sent is a
-- fact about what a client received, and deleting it would make a second send possible.
GRANT SELECT, INSERT, UPDATE ON nzi_console.strategy_automation_log TO nzi_console_worker;
GRANT SELECT ON nzi_console.strategy_automation_log TO nzi_console_app;

-- ── Consent ──────────────────────────────────────────────────────────────────────────

-- Following the training model (`training_bookings.consent_status`), which holds rather
-- than assumes: `unknown` is not permission. Only `granted` is written to, so no contact
-- receives mail until someone has recorded that they may.
ALTER TABLE nzi_console.client_contacts
  ADD COLUMN email_consent text NOT NULL DEFAULT 'unknown'
    CHECK (email_consent IN ('unknown','granted','declined'));

COMMENT ON COLUMN nzi_console.client_contacts.email_consent IS
  'Whether this contact may be emailed by automations. Defaults to unknown, which holds: an absent decision is not consent.';

-- ── The outbox as a send queue ───────────────────────────────────────────────────────

-- `transactional_outbox` has been written by every command since 0001 and drained by
-- nothing, so it holds a standing backlog of rows whose topics no mail handler recognises.
-- Marking those 'sent' would record a delivery that never happened. 'skipped' is the honest
-- terminal state for "seen, understood, nothing to deliver".
--
-- The old CHECK was created inline in 0001 and is therefore auto-named. Dropping it by its
-- assumed name would break on any database where Postgres chose differently, so it is found
-- rather than guessed — the same approach 0078 used for its renames.
DO $$
DECLARE constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'nzi_console.transactional_outbox'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%state%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE nzi_console.transactional_outbox DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE nzi_console.transactional_outbox
  ADD CONSTRAINT transactional_outbox_state_check
    CHECK (state IN ('pending','processing','sent','skipped','failed'));

COMMENT ON COLUMN nzi_console.transactional_outbox.state IS
  'pending → processing → sent | skipped | failed. "skipped" means no handler claimed the topic — the honest outcome for the pre-drainer backlog, which must never be reported as delivered.';

-- What the worker must read to compose a reminder. Reads only: the worker never edits a
-- plan, a client or a contact. `transactional_outbox` and `audit_events` were granted in
-- 0002 and are deliberately not re-granted here.
GRANT SELECT ON nzi_console.client_strategies TO nzi_console_worker;
GRANT SELECT ON nzi_console.clients TO nzi_console_worker;
GRANT SELECT ON nzi_console.client_contacts TO nzi_console_worker;
GRANT SELECT ON nzi_console.reduction_strategies TO nzi_console_worker;

COMMIT;
