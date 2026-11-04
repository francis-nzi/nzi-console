-- 0206 Message notifications (RULING-portal-messages, M4): the debounce ledger for "you have a new message" emails.
--
-- ## What it is
--
-- A message in a conversation writes (or joins) ONE pending row per thread and audience - `client` (the portal users who can see the
-- thread) or `staff` (the thread's owner, else the client's adviser). The worker's scan, after the row's window has passed, sends at most one
-- notify-only email per recipient for the whole burst and closes the row. A flurry of messages is therefore one email, not many; the next
-- message after the window opens a new row.
--
-- ## Properties
--
--   * **One pending row per (thread, audience).** A partial unique index; a further message in the window only counts itself in.
--   * **Ids and counts only.** No address, name or message text: the recipients are resolved at send time from the records that own them
--     (consent from the client's contact, the address from the portal user or the member), and each email is an ordinary `email_messages`
--     row. So the ledger holds no personal data and is not in piiInventory.ts.
--   * **The window is the row's `due_at`**, set from the first message of a burst; nothing here sends. Sending is the worker's scan (through
--     sendTemplatedEmail and the existing email drain), so a dark deployment simply leaves rows pending.
--   * **Never deleted.** A processed row stays (state `done`) with what happened, in counts: how many were emailed, how many were not because
--     they had not consented, and whether anyone could be reached at all.

BEGIN;

CREATE TABLE nzi_console.portal_message_notifications (
  organisation_id text NOT NULL,
  notification_id text NOT NULL,
  thread_id text NOT NULL,
  client_id text NOT NULL,
  audience text NOT NULL CHECK (audience IN ('client', 'staff')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done')),
  message_count integer NOT NULL DEFAULT 1 CHECK (message_count >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  processed_at timestamptz,
  emailed integer CHECK (emailed IS NULL OR emailed >= 0),
  blocked_no_consent integer CHECK (blocked_no_consent IS NULL OR blocked_no_consent >= 0),
  no_recipient boolean,
  PRIMARY KEY (organisation_id, notification_id),
  FOREIGN KEY (organisation_id, thread_id) REFERENCES nzi_console.portal_threads (organisation_id, thread_id),
  CONSTRAINT portal_message_notifications_done_shape CHECK ((state = 'pending') = (processed_at IS NULL AND emailed IS NULL AND blocked_no_consent IS NULL AND no_recipient IS NULL))
);
CREATE UNIQUE INDEX portal_message_notifications_one_pending ON nzi_console.portal_message_notifications (organisation_id, thread_id, audience) WHERE state = 'pending';
CREATE INDEX portal_message_notifications_due ON nzi_console.portal_message_notifications (organisation_id, due_at) WHERE state = 'pending';

ALTER TABLE nzi_console.portal_message_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.portal_message_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.portal_message_notifications
  USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

REVOKE ALL ON nzi_console.portal_message_notifications FROM PUBLIC;
-- The console (a message's command) opens or joins a pending row; the worker closes it. Neither deletes.
GRANT SELECT, INSERT, UPDATE ON nzi_console.portal_message_notifications TO nzi_console_app;
GRANT SELECT, UPDATE ON nzi_console.portal_message_notifications TO nzi_console_worker;
REVOKE DELETE ON nzi_console.portal_message_notifications FROM PUBLIC, nzi_console_app, nzi_console_worker;

-- What the worker's scan reads to decide who to tell - column by column, and nothing it could change. It already reads client_contacts (consent) and the
-- member columns the email signature needs; the rest is the thread, the client's portal users and their job grants, and the client's name and adviser.
GRANT SELECT (organisation_id, thread_id, client_id, scope, job_id, owner_id) ON nzi_console.portal_threads TO nzi_console_worker;
GRANT SELECT (organisation_id, portal_user_id, client_id, email_normalized, display_name, status) ON nzi_console.portal_users TO nzi_console_worker;
GRANT SELECT (organisation_id, portal_user_id, client_id, job_id, revoked_at) ON nzi_console.portal_access_grants TO nzi_console_worker;
GRANT SELECT (organisation_id, client_id, name, client_manager_user_id, owner_user_id) ON nzi_console.clients TO nzi_console_worker;

COMMENT ON TABLE nzi_console.portal_message_notifications IS
  'Debounce ledger for notify-only message emails: one pending row per thread and audience, closed by the worker scan after its window. Ids and counts only; never deleted.';

COMMIT;
