-- 0178 The email send log (email programme phase 1, BUILD-email-sender-resend, 23 Oct 2026).
--
-- ## Why
--
-- Outbound email goes through one pipe: `sendEmail` writes a row here (`queued`) and an `email.send` row on
-- `transactional_outbox` in the same transaction; the outbox drainer (the reminder worker) reads this row and hands it to
-- Resend, or records it as `stubbed` when no key is set or the isolation gate refuses the recipient. A request handler never
-- calls the provider. Invites, resets and portal notifications (phases 2–4) send through it, and the roster's "Invitation
-- sent / expired / resend" state will read it.
--
-- ## The guarantees, and what holds each one
--
--   * **One logical send per key.** `(organisation_id, idempotency_key)` is unique: enqueuing the same send twice returns the
--     first row and writes no second outbox row.
--   * **No double delivery.** The drainer sends only from `queued`, and passes `email_message_id` to Resend as its
--     `Idempotency-Key`, so a crash between the provider accepting and this row being updated cannot produce a second email
--     when the outbox row is redelivered.
--   * **The body is held only until it is resolved.** A body is in flight, not a record: phase 2 puts single-use enrolment
--     links in it, and a credential left at rest after delivery is one more place to leak it. The CHECKs make a resolved row
--     with a body, or a queued row without one, unrepresentable. Subject, recipient and outcome stay.
--   * **`sent` means the provider accepted it**, so a `sent` row carries the provider's message id.
--
-- The outbox's state CHECK (0083) already admits everything the drainer writes; `topic` is free text, so `email.send` needs
-- no enum change. The outbox payload carries only `{ emailMessageId }` — no address — so the outbox's PII entry is unchanged.

BEGIN;

CREATE TABLE nzi_console.email_messages (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  email_message_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
  correlation_id text NOT NULL CHECK (correlation_id <> ''),
  -- Null in phase 1, which sends plain system mail; phase 2 sends from the message-template registry.
  template_code text,
  to_email text NOT NULL CHECK (to_email = lower(btrim(to_email)) AND to_email <> ''),
  -- Null means the deployment's EMAIL_FROM, resolved at send time.
  from_address text,
  reply_to text,
  subject text NOT NULL CHECK (btrim(subject) <> ''),
  html_body text,
  text_body text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','stubbed')),
  provider_message_id text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Why the last attempt failed, or why a send was stubbed. Never a credential, a header or a body.
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  PRIMARY KEY (organisation_id, email_message_id),
  CONSTRAINT email_messages_queued_has_body CHECK (status <> 'queued' OR html_body IS NOT NULL OR text_body IS NOT NULL),
  CONSTRAINT email_messages_resolved_has_no_body CHECK (status = 'queued' OR (html_body IS NULL AND text_body IS NULL)),
  CONSTRAINT email_messages_resolved_at CHECK ((status = 'queued') = (resolved_at IS NULL)),
  CONSTRAINT email_messages_sent_has_provider_id CHECK (status <> 'sent' OR provider_message_id IS NOT NULL)
);

CREATE UNIQUE INDEX email_messages_idempotency_idx ON nzi_console.email_messages (organisation_id, idempotency_key);
CREATE INDEX email_messages_status_idx ON nzi_console.email_messages (organisation_id, status, created_at);
CREATE INDEX email_messages_correlation_idx ON nzi_console.email_messages (organisation_id, correlation_id);

COMMENT ON TABLE nzi_console.email_messages IS
  'One row per outbound email: queued by sendEmail beside an email.send outbox row, resolved by the drainer to sent (provider accepted), stubbed (recorded, never sent) or failed. The body is cleared on resolution.';
COMMENT ON COLUMN nzi_console.email_messages.status IS
  'queued → sent | stubbed | failed. stubbed is a successful outcome that put nothing on the wire: no RESEND_API_KEY, or the isolation gate refused the recipient; last_error says which.';

ALTER TABLE nzi_console.email_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.email_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.email_messages
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

-- The console enqueues (and, in phase 2, reads the roster's invitation state); the worker enqueues from the test-send script,
-- and resolves. Nobody deletes: a send that happened is a fact about what someone received.
GRANT SELECT, INSERT ON nzi_console.email_messages TO nzi_console_app;
GRANT SELECT, INSERT, UPDATE ON nzi_console.email_messages TO nzi_console_worker;

COMMIT;
