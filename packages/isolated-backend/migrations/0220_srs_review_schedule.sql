-- 0220 SRS review date + reminder (BRIEF-srs-iterative-review-and-messaging, Phase A): when a completed readiness assessment is
-- next due for review, and a once-per-date reminder to the CRM through the A3 email pipe.
--
-- ## What is added
--
-- - **The review schedule, on the assessment**: `review_cadence` (`annual` · `biannual` · `custom` · `off`) and the resolved
--   `next_review_date`. Set when an assessment completes (annual: assessed date + 12 months) and changed by the CRM under
--   srs.manage (`srs.assessment.review.set`). A completed assessment always has a cadence; `off` is exactly "no date". A draft
--   holds whatever it had — a reopen leaves the schedule as it was, and the scan never reads a draft.
-- - **The sent-marker**: `srs_review_reminders`, one row per reminder enqueued, unique on (assessment, review date) — the A3
--   pattern (0190): the scan and the enqueue are one transaction, so winning that insert is how a tick earns the send, a re-tick
--   for the same date sends nothing, and a changed date is a new key, so it re-arms. The recipient is named by user id and the
--   email by its `email_messages` id — never the address.
--
-- ## The backfill
--
-- Every assessment already complete gets the default: `annual`, assessed date + 12 months (Postgres month arithmetic, which the
-- contract's `srsNextReviewDate` matches — 29 Feb rolls to 28 Feb). Nothing sends until the Admin reminder switch (0190) is on.
--
-- ## What the worker may now read
--
-- The scan runs as `nzi_console_worker`, which has never read assessments. It is granted the **columns the scan needs only**
-- — not the notes, not the answers. Nothing is deleted from here: a reminder enqueued is a fact about what was sent.

BEGIN;

-- ── The schedule ─────────────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE nzi_console.srs_assessments
  ADD COLUMN review_cadence text CHECK (review_cadence IS NULL OR review_cadence IN ('annual', 'biannual', 'custom', 'off')),
  ADD COLUMN next_review_date date;

UPDATE nzi_console.srs_assessments
   SET review_cadence = 'annual', next_review_date = (assessed_on + interval '12 months')::date
 WHERE status = 'complete';

ALTER TABLE nzi_console.srs_assessments
  ADD CONSTRAINT srs_assessments_review_shape CHECK (
    status = 'draft' OR (review_cadence IS NOT NULL AND (review_cadence = 'off') = (next_review_date IS NULL)));

COMMENT ON COLUMN nzi_console.srs_assessments.review_cadence IS
  'SRS review loop (0220): annual (default) · biannual (every 6 months) · custom (a date the CRM chose) · off. Set on completion; srs.manage changes it.';
COMMENT ON COLUMN nzi_console.srs_assessments.next_review_date IS
  'SRS review loop (0220): when the CRM is next due to review this assessment. Null exactly when the cadence is off.';

-- ── The sent-marker ──────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE nzi_console.srs_review_reminders (
  organisation_id text NOT NULL,
  reminder_id text NOT NULL,
  assessment_id text NOT NULL,
  client_id text NOT NULL,
  -- The review date the reminder was about, as it stood when it was enqueued. Part of the key: a moved date re-arms.
  review_date date NOT NULL,
  lead_days smallint NOT NULL CHECK (lead_days BETWEEN 0 AND 90),
  recipient_user_id text NOT NULL,
  template_code text NOT NULL,
  email_message_id text NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, reminder_id),
  FOREIGN KEY (organisation_id, assessment_id) REFERENCES nzi_console.srs_assessments(organisation_id, assessment_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id),
  FOREIGN KEY (organisation_id, email_message_id) REFERENCES nzi_console.email_messages(organisation_id, email_message_id)
);
-- The idempotency key: once per assessment per review date, for all time.
CREATE UNIQUE INDEX srs_review_reminders_once_idx ON nzi_console.srs_review_reminders (organisation_id, assessment_id, review_date);
COMMENT ON TABLE nzi_console.srs_review_reminders IS
  'SRS review loop (0220): one row per review reminder enqueued to the CRM. (assessment, review date) is unique, so a re-tick never re-sends and a moved date re-arms. Recipient by user id, the email by id — never the address.';

ALTER TABLE nzi_console.srs_review_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.srs_review_reminders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.srs_review_reminders
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT ON nzi_console.srs_review_reminders TO nzi_console_worker;
GRANT SELECT ON nzi_console.srs_review_reminders TO nzi_console_app;
REVOKE UPDATE, DELETE ON nzi_console.srs_review_reminders FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

-- ── What the scan reads, column by column ────────────────────────────────────────────────────────────────────────────
GRANT SELECT (organisation_id, assessment_id, client_id, status, started_on, assessed_on, review_cadence, next_review_date)
  ON nzi_console.srs_assessments TO nzi_console_worker;

-- Everything the scan touches, asserted — a gap fails here, not on every tick (the 0183 lesson).
DO $$
DECLARE
  needed record;
  missing text[] := '{}';
BEGIN
  FOR needed IN SELECT * FROM (VALUES
    ('organisation_reminder_settings', 'SELECT'), ('srs_review_reminders', 'SELECT'), ('srs_review_reminders', 'INSERT'),
    ('message_templates', 'SELECT'), ('email_messages', 'INSERT'), ('transactional_outbox', 'INSERT'), ('audit_events', 'INSERT')
  ) AS t(table_name, privilege) LOOP
    IF NOT has_table_privilege('nzi_console_worker', format('nzi_console.%I', needed.table_name), needed.privilege) THEN
      missing := missing || format('%s on %s', needed.privilege, needed.table_name);
    END IF;
  END LOOP;
  FOR needed IN SELECT * FROM (VALUES
    ('srs_assessments', 'next_review_date'), ('srs_assessments', 'review_cadence'), ('clients', 'client_manager_user_id'),
    ('clients', 'owner_user_id'), ('clients', 'name'), ('memberships', 'email'), ('memberships', 'first_name'), ('memberships', 'status')
  ) AS t(table_name, column_name) LOOP
    IF NOT has_column_privilege('nzi_console_worker', format('nzi_console.%I', needed.table_name), needed.column_name, 'SELECT') THEN
      missing := missing || format('SELECT (%s) on %s', needed.column_name, needed.table_name);
    END IF;
  END LOOP;
  IF has_table_privilege('nzi_console_worker', 'nzi_console.srs_assessments', 'SELECT')
     OR has_column_privilege('nzi_console_worker', 'nzi_console.srs_assessments', 'notes', 'SELECT') THEN
    missing := missing || 'the assessment''s notes are readable'::text;
  END IF;
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION '0220: nzi_console_worker is not granted as the SRS review scan needs: %', array_to_string(missing, ', ');
  END IF;
END $$;

COMMIT;
