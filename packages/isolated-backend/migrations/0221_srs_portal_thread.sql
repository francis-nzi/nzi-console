-- 0221 SRS portal messaging (BRIEF-srs-iterative-review-and-messaging, Phase B): one conversation per client about their SRS
-- readiness, on the portal conversations (0201) and their notify-only email (0206) — not a second messaging system.
--
-- ## What is added
--
-- - **`portal_threads.srs_readiness`**: marks the client's SRS readiness thread — client-wide, under the provisioned `srs`
--   subject, never a report's thread. At most one per client (a partial unique index), so the readiness view and the CRM's SRS
--   area always open the same conversation; it is created by the first message from either side.
-- - **`portal_messages.review_request`**: a client's message may ask for a review of their assessment. It is surfaced to the CRM,
--   who reopens or reassesses through the existing commands — the portal never reopens anything (NZC-022). Only a client's
--   message can carry it, and messages stay append-only (nobody holds UPDATE), so the flag is as written.
--
-- ## What the worker may now read
--
-- The notification scan links an SRS thread's emails to the readiness view (client) and the client's SRS area (staff) rather
-- than the generic conversation, so it reads the new column — that column only.

BEGIN;

ALTER TABLE nzi_console.portal_threads
  ADD COLUMN srs_readiness boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT portal_threads_srs_shape CHECK (NOT srs_readiness OR (scope = 'client' AND subject_code = 'srs' AND report_version_id IS NULL));
CREATE UNIQUE INDEX portal_threads_srs_one_per_client ON nzi_console.portal_threads (organisation_id, client_id) WHERE srs_readiness;
COMMENT ON COLUMN nzi_console.portal_threads.srs_readiness IS
  'SRS messaging (0221): the client''s one conversation about their SRS readiness — client-wide, srs subject. At most one per client.';

ALTER TABLE nzi_console.portal_messages
  ADD COLUMN review_request boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT portal_messages_review_request_by_client CHECK (NOT review_request OR author_principal = 'portal');
COMMENT ON COLUMN nzi_console.portal_messages.review_request IS
  'SRS messaging (0221): the client asks for a review of their readiness assessment. Surfaced to the CRM, who reopens through the existing command; never acted on by the portal.';

GRANT SELECT (srs_readiness) ON nzi_console.portal_threads TO nzi_console_worker;

DO $$
BEGIN
  IF NOT has_column_privilege('nzi_console_worker', 'nzi_console.portal_threads', 'srs_readiness', 'SELECT') THEN
    RAISE EXCEPTION '0221: nzi_console_worker cannot read portal_threads.srs_readiness, which the notification scan links by';
  END IF;
  IF has_table_privilege('nzi_console_app', 'nzi_console.portal_messages', 'UPDATE') THEN
    RAISE EXCEPTION '0221: portal messages must stay append-only — a review request is as written';
  END IF;
END $$;

COMMIT;
