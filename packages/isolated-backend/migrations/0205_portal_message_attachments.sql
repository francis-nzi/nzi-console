-- 0205 Message attachments (RULING-portal-messages, M3): a file attached to a conversation message.
--
-- ## What it is
--
-- An attachment is an ordinary `portal_files` row (0198) - arrived through the same gate (quarantined, scanned, released only when clean),
-- audited the same way, served only by a signed URL - plus a link to the message it was sent with. There is no second file path and no
-- file bytes or storage identifier here: this table holds two ids.
--
-- ## Properties
--
--   * **Append-only.** A link is written with its message and never changed or removed (no UPDATE or DELETE for any runtime role), as
--     the message itself is. A withdrawn file stays linked: the message shows "withdrawn", not a gap.
--   * **One message per file.** A file belongs to the message it was sent with; it is not re-attached elsewhere.
--   * **Tenant-isolated.** Row-level security, forced, on the organisation, as the tables it joins.
--   * **Same-client by construction.** Both foreign keys are inside the organisation; the command additionally ties the file to the
--     thread's client and job, and the read joins through the thread, so a link can never surface a file in another client's thread.
--   * **No personal data of its own.** Two opaque ids and a time; the message and the file keep theirs (see piiInventory.ts).

BEGIN;

CREATE TABLE nzi_console.portal_message_attachments (
  organisation_id text NOT NULL,
  message_id text NOT NULL,
  file_id text NOT NULL,
  position integer NOT NULL CHECK (position >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, message_id, file_id),
  CONSTRAINT portal_message_attachments_one_message_per_file UNIQUE (organisation_id, file_id),
  CONSTRAINT portal_message_attachments_position_uq UNIQUE (organisation_id, message_id, position),
  FOREIGN KEY (organisation_id, message_id) REFERENCES nzi_console.portal_messages (organisation_id, message_id),
  FOREIGN KEY (organisation_id, file_id) REFERENCES nzi_console.portal_files (organisation_id, file_id)
);

ALTER TABLE nzi_console.portal_message_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.portal_message_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.portal_message_attachments
  USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

REVOKE ALL ON nzi_console.portal_message_attachments FROM PUBLIC;
GRANT SELECT, INSERT ON nzi_console.portal_message_attachments TO nzi_console_app;
REVOKE UPDATE, DELETE ON nzi_console.portal_message_attachments FROM PUBLIC, nzi_console_app, nzi_console_worker;

COMMENT ON TABLE nzi_console.portal_message_attachments IS
  'Append-only. Links a conversation message to a portal_files row that arrived through the file gate with it. Ids only; the file keeps its own status, so a held or withdrawn attachment is never served.';

COMMIT;
