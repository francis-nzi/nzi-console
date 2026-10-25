-- 0179 Message templates carry an HTML body beside the text (email programme phase 2, BUILD-message-templates-phase2, R2).
--
-- ## Why
--
-- 0149's `message_templates` holds a subject and a plain-text body. Phase 2 sends the transactional mails (portal access
-- invites, password resets, the new-message notification, the staff invitation) as multipart HTML + text through
-- `sendTemplatedEmail`, and an organisation's own wording for those keys needs somewhere to keep its HTML.
--
-- ## What it adds
--
-- **`html_body`**, nullable. Null — every existing row, and any key sent as plain text — means the HTML part is made from
-- the text body at send time, so the two parts never say different things. Which keys may have one is the code registry's
-- (`htmlPart`), checked by the command; the column only bounds it. What the body may contain (declared tokens only; no
-- script or other active content; no single-use link written into it, R5) is checked by the command, as the text is.
--
-- The application role gains UPDATE on the new column alone, beside 0149's column grant; INSERT is already table-wide.
-- The worker's SELECT (0149) covers it. Nothing is backfilled and nothing is deleted.

BEGIN;

ALTER TABLE nzi_console.message_templates
  ADD COLUMN html_body text CHECK (html_body IS NULL OR (btrim(html_body) <> '' AND length(html_body) <= 50000));

COMMENT ON COLUMN nzi_console.message_templates.html_body IS
  'The HTML body, for a key the registry sends as HTML (htmlPart). Null: the HTML part is made from the text body at send time.';

GRANT UPDATE (html_body) ON nzi_console.message_templates TO nzi_console_app;

COMMIT;
