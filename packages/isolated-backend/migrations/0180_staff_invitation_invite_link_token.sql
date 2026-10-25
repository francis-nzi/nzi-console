-- 0180 The staff invitation's link token is {{inviteLink}}, as every other invite's is (email programme phase 3, R4).
--
-- ## Why
--
-- `staff.invitation` declared its link as `{{link}}`; the portal invite (phase 2) declares `{{inviteLink}}`. Phase 3 ruled one
-- name across all invites, renamed in the same change as the send-site that fills it. The registry now declares
-- `inviteLink` and no longer `link`, so an organisation's saved wording that still says `{{link}}` would be refused by the
-- strict render (an undeclared token, and the required link missing) — an invitation that could not be sent. This rewrites
-- that wording so every saved row stays valid.
--
-- ## What it changes, and what it leaves
--
-- - **Only `staff.invitation` rows whose subject, body or HTML body contains `{{link}}`**, each occurrence replaced by
--   `{{inviteLink}}`. The exact token only: `{{links}}` and the like are not the token and are left alone (and could not
--   have been saved — the command refuses undeclared tokens).
-- - **The version is bumped and `updated_at` set**, so a drawer opened before the deploy is told the wording changed rather
--   than saving over it.
-- - **`updated_by` is left as it was.** The v7 template loader reads a row last written by an import run as "still as the
--   import wrote it" (R4 of admin F1); stamping this migration there would make the next re-run refuse a genuine v7 change
--   as "edited here since". The rewrite is recorded instead as a `message_template.updated` audit event per row, actor
--   `migration:0180`, before and after in full (a template is wording, not personal data), as 0175 records its retirements.
-- - Active and inactive rows alike: a deactivated wording that is reinstated later must still be sendable.
--
-- Asserted afterwards: no `staff.invitation` row still contains `{{link}}`.

BEGIN;

WITH rewritten AS (
  UPDATE nzi_console.message_templates t
     SET subject = replace(t.subject, '{{link}}', '{{inviteLink}}'),
         body = replace(t.body, '{{link}}', '{{inviteLink}}'),
         html_body = replace(t.html_body, '{{link}}', '{{inviteLink}}'),
         version = t.version + 1,
         updated_at = now()
    FROM nzi_console.message_templates before
   WHERE t.template_key = 'staff.invitation'
     AND (before.organisation_id, before.template_key) = (t.organisation_id, t.template_key)
     AND (position('{{link}}' IN t.subject) > 0 OR position('{{link}}' IN t.body) > 0 OR position('{{link}}' IN coalesce(t.html_body, '')) > 0)
  RETURNING t.organisation_id, t.template_key, t.version,
            before.subject AS before_subject, before.body AS before_body, before.html_body AS before_html, before.active AS active,
            t.subject, t.body, t.html_body
)
INSERT INTO nzi_console.audit_events
  (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, before_json, after_json)
SELECT r.organisation_id, gen_random_uuid()::text, 'migration:0180', 'system', 'message_template.updated', 'message_template',
       r.template_key, 'migration:0180',
       'The staff invitation''s link token is renamed {{link}} → {{inviteLink}}, one name across all invites (email programme phase 3, R4). Wording otherwise unchanged.',
       jsonb_build_object('templateKey', r.template_key, 'subject', r.before_subject, 'body', r.before_body, 'html', r.before_html, 'active', r.active),
       jsonb_build_object('templateKey', r.template_key, 'subject', r.subject, 'body', r.body, 'html', r.html_body, 'active', r.active, 'version', r.version)
  FROM rewritten r;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM nzi_console.message_templates WHERE template_key = 'staff.invitation'
              AND (position('{{link}}' IN subject) > 0 OR position('{{link}}' IN body) > 0 OR position('{{link}}' IN coalesce(html_body, '')) > 0)) THEN
    RAISE EXCEPTION '0180: a staff.invitation template still uses {{link}} after the rewrite.';
  END IF;
END $$;

COMMIT;
