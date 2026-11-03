-- Portal Updates (RULING-portal-messages, M2): a portal user's seen watermark for the Updates feed - the only thing the feed stores.
-- The notices themselves are derived at read time from events that already exist (a published report, a reviewer's decision, a data-entry window,
-- a live broadcast), so there is nothing here to keep in step with them: one row per user saying "everything up to this moment is seen".
-- It is a pointer to the portal user and holds no personal data of its own.
BEGIN;

CREATE TABLE nzi_console.portal_notice_seen (
  organisation_id text NOT NULL,
  portal_user_id text NOT NULL,
  seen_through timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, portal_user_id),
  FOREIGN KEY (organisation_id, portal_user_id) REFERENCES nzi_console.portal_users(organisation_id, portal_user_id)
);

ALTER TABLE nzi_console.portal_notice_seen ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.portal_notice_seen FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.portal_notice_seen USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
-- A watermark only moves forward, by the command; nobody deletes one.
GRANT SELECT, INSERT, UPDATE ON nzi_console.portal_notice_seen TO nzi_console_app;
COMMENT ON TABLE nzi_console.portal_notice_seen IS 'One row per portal user: the Updates feed is seen through this moment. A pointer to the user; holds no personal data. The notices are derived, not stored.';

COMMIT;
