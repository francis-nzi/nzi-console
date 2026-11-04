-- 0207 A first name on client contacts and on the team, so people are addressed as people.
--
-- ## Why
--
-- Greetings, emails and chips were built from the full name, or from a first word split off it at each call site
-- (`display_name.split(" ")[0]` in five places, each its own rule). A first name is now a field of its own: held, editable,
-- and the one place every address-a-person surface reads.
--
-- ## What it adds
--
-- - **`client_contacts.first_name`** and **`memberships.first_name`** — how the person is addressed. Nullable: null means
--   "not held", and a reader then falls back to the first word of the full name (and to "there" when there is no name), so
--   nothing ever greets blank. The full name stays, unchanged, as the record of who the person is (audit trails, signatures,
--   data-subject records).
-- - **`first_name_sealed`** beside each, because a first name is personal data (NZC-119): sealed under the person's own key
--   in the same transaction as every write, in the PII inventory so export and erasure reach it like the name beside it.
--
-- ## The backfill, and what it does not do
--
-- Every existing row gets `first_name` = the first whitespace-separated word of its full name, trimmed. It is a default,
-- not a fact: "Dr. Jane Smith" defaults to "Dr." until somebody edits it, which is why both forms expose the field.
--
-- - It writes the plaintext column only. Ciphertext needs the subject's key, which lives in the application, so the existing
--   encryption backfill (`backfill-pii-encryption`, queue = plaintext present and ciphertext absent) seals these rows; run it
--   after this migration. Nothing reads `first_name_sealed` for display in the meantime.
-- - It does **not** bump `version` or `updated_at`: nobody edited anything, and a bump would make every open drawer refuse
--   its save as stale.
-- - An erased person (full name already nulled) gets no first name.
--
-- ## Saved wording
--
-- Four built-in emails greeted "Hello {{displayName}}" and now greet "Hello {{firstName}}". An organisation's saved wording for
-- those keys is rewritten the same way (the exact greeting only; `displayName` stays declared, so any other use of it still
-- renders), version bumped, `updated_by` left as it was and the rewrite audited per row — as 0180 did for `{{link}}`.
--
-- ## The worker
--
-- The notification scans address a member of staff by first name and read `memberships` column by column (0190, 0206).
-- `first_name` is added to that list and no other.

BEGIN;

ALTER TABLE nzi_console.client_contacts
  ADD COLUMN first_name text CHECK (first_name IS NULL OR (first_name = btrim(first_name) AND first_name <> '' AND length(first_name) <= 120)),
  ADD COLUMN first_name_sealed jsonb;

ALTER TABLE nzi_console.memberships
  ADD COLUMN first_name text CHECK (first_name IS NULL OR (first_name = btrim(first_name) AND first_name <> '' AND length(first_name) <= 120)),
  ADD COLUMN first_name_sealed jsonb;

COMMENT ON COLUMN nzi_console.client_contacts.first_name IS
  'How the contact is addressed. Defaulted from the first word of full_name, always editable; null falls back to that word at read. Sealed beside it. Not for attribution: audit, signatures and data-subject records keep full_name.';
COMMENT ON COLUMN nzi_console.memberships.first_name IS
  'How the member is addressed. Defaulted from the first word of display_name, always editable; null falls back to that word at read. Sealed beside it. Not for attribution: audit, signatures and data-subject records keep display_name.';

UPDATE nzi_console.client_contacts
   SET first_name = left(substring(btrim(full_name) from '^\S+'), 120)
 WHERE first_name IS NULL AND nullif(btrim(full_name), '') IS NOT NULL;

UPDATE nzi_console.memberships
   SET first_name = left(substring(btrim(display_name) from '^\S+'), 120)
 WHERE first_name IS NULL AND nullif(btrim(display_name), '') IS NOT NULL;

GRANT SELECT (first_name) ON nzi_console.memberships TO nzi_console_worker;

-- ── Saved wording that greets by full name ───────────────────────────────────────────────────────────────────────────
WITH rewritten AS (
  UPDATE nzi_console.message_templates t
     SET subject = replace(t.subject, 'Hello {{displayName}}', 'Hello {{firstName}}'),
         body = replace(t.body, 'Hello {{displayName}}', 'Hello {{firstName}}'),
         html_body = replace(t.html_body, 'Hello {{displayName}}', 'Hello {{firstName}}'),
         version = t.version + 1,
         updated_at = now()
    FROM nzi_console.message_templates before
   WHERE t.template_key IN ('portal.access.invite', 'password.reset.staff', 'password.reset.portal', 'message.notification')
     AND (before.organisation_id, before.template_key) = (t.organisation_id, t.template_key)
     AND (position('Hello {{displayName}}' IN t.subject) > 0 OR position('Hello {{displayName}}' IN t.body) > 0
          OR position('Hello {{displayName}}' IN coalesce(t.html_body, '')) > 0)
  RETURNING t.organisation_id, t.template_key, t.version,
            before.subject AS before_subject, before.body AS before_body, before.html_body AS before_html, before.active AS active,
            t.subject, t.body, t.html_body
)
INSERT INTO nzi_console.audit_events
  (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, before_json, after_json)
SELECT r.organisation_id, gen_random_uuid()::text, 'migration:0207', 'system', 'message_template.updated', 'message_template',
       r.template_key, 'migration:0207',
       'The greeting addresses the person by first name: "Hello {{displayName}}" → "Hello {{firstName}}". Wording otherwise unchanged.',
       jsonb_build_object('templateKey', r.template_key, 'subject', r.before_subject, 'body', r.before_body, 'html', r.before_html, 'active', r.active),
       jsonb_build_object('templateKey', r.template_key, 'subject', r.subject, 'body', r.body, 'html', r.html_body, 'active', r.active, 'version', r.version)
  FROM rewritten r;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM nzi_console.client_contacts WHERE first_name IS NULL AND nullif(btrim(full_name), '') IS NOT NULL) THEN
    RAISE EXCEPTION '0207: a client contact with a name has no first name after the backfill.';
  END IF;
  IF EXISTS (SELECT 1 FROM nzi_console.memberships WHERE first_name IS NULL AND nullif(btrim(display_name), '') IS NOT NULL) THEN
    RAISE EXCEPTION '0207: a member with a name has no first name after the backfill.';
  END IF;
  IF EXISTS (SELECT 1 FROM nzi_console.message_templates
              WHERE template_key IN ('portal.access.invite', 'password.reset.staff', 'password.reset.portal', 'message.notification')
                AND (position('Hello {{displayName}}' IN subject) > 0 OR position('Hello {{displayName}}' IN body) > 0
                     OR position('Hello {{displayName}}' IN coalesce(html_body, '')) > 0)) THEN
    RAISE EXCEPTION '0207: saved wording still greets by {{displayName}} after the rewrite.';
  END IF;
  IF has_table_privilege('nzi_console_worker', 'nzi_console.memberships', 'SELECT') THEN
    RAISE EXCEPTION '0207: nzi_console_worker can read the whole of memberships; only columns were meant.';
  END IF;
END $$;

COMMIT;
