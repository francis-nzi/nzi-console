-- Portal conversations (RULING-portal-messages, M1): a client's two-way threads with their adviser - tagged by subject, scoped to the
-- client or a job, owned by a member of staff, with a state and a surfaced (not enforced) response target. Messages are append-only.
--
-- The report page's comments (portal_report_comments, 0020) are one conversation with these, not two: every report version that has comments
-- gets a Reports-tagged job thread (`report_version_id`), the existing comments are copied in as its messages, and from here a comment
-- written on the report page is mirrored into its thread and a message written in the thread is mirrored out to the report page - by the
-- one function below (`mirror_report_comment_to_thread`), so the backfill and the live path cannot disagree. No comment is lost or changed.
--
-- A message names its author by id only (a name is joined at read), so nothing here holds a copy of anyone's name. Nobody has DELETE.

BEGIN;

-- ── The CRM-configurable subject tags (0149's message-template / 0145's lookup pattern: per organisation, provisioned, never deleted) ──

CREATE TABLE nzi_console.portal_thread_subjects (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  subject_code text NOT NULL CHECK (subject_code ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text NOT NULL CHECK (btrim(label) <> '' AND length(label) <= 40),
  sort_order integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, subject_code)
);

CREATE FUNCTION nzi_console.provision_portal_thread_subjects(p_organisation_id text) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, nzi_console AS $$
BEGIN
  INSERT INTO nzi_console.portal_thread_subjects (organisation_id, subject_code, label, sort_order)
  SELECT p_organisation_id, v.code, v.label, v.ord
    FROM (VALUES ('data', 'Data', 10), ('reports', 'Reports', 20), ('srs', 'SRS', 30), ('actions', 'Actions', 40), ('general', 'General', 50)) AS v(code, label, ord)
  ON CONFLICT (organisation_id, subject_code) DO NOTHING;
END;
$$;
CREATE FUNCTION nzi_console.provision_new_portal_thread_subjects() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM nzi_console.provision_portal_thread_subjects(NEW.organisation_id); RETURN NEW; END;
$$;
CREATE TRIGGER provision_portal_thread_subjects_on_insert AFTER INSERT ON nzi_console.organisations
  FOR EACH ROW EXECUTE FUNCTION nzi_console.provision_new_portal_thread_subjects();
SELECT nzi_console.provision_portal_thread_subjects(organisation_id) FROM nzi_console.organisations;

-- ── Threads and messages ───────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE nzi_console.portal_threads (
  organisation_id text NOT NULL,
  thread_id text NOT NULL,
  client_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('client', 'job')),
  job_id text,
  subject_code text NOT NULL,
  title text NOT NULL CHECK (btrim(title) <> '' AND length(title) <= 160),
  state text NOT NULL CHECK (state IN ('open', 'awaiting_nzi', 'awaiting_client', 'resolved')),
  owner_id text,
  started_by_principal text NOT NULL CHECK (started_by_principal IN ('portal', 'staff')),
  started_by_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  message_count integer NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  -- Surfaced, never enforced (v1): while the client waits on the adviser, the date a reply is looked for by; otherwise null.
  response_target_at timestamptz,
  resolved_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  -- The report version whose comments this thread is the conversation of (the bridge); at most one thread per report version.
  report_version_id text,
  PRIMARY KEY (organisation_id, thread_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id),
  FOREIGN KEY (organisation_id, subject_code) REFERENCES nzi_console.portal_thread_subjects(organisation_id, subject_code),
  FOREIGN KEY (organisation_id, owner_id) REFERENCES nzi_console.memberships(organisation_id, user_id),
  FOREIGN KEY (organisation_id, report_version_id) REFERENCES nzi_console.report_versions(organisation_id, report_version_id),
  CONSTRAINT portal_threads_scope_job CHECK ((scope = 'client' AND job_id IS NULL) OR (scope = 'job' AND job_id IS NOT NULL)),
  CONSTRAINT portal_threads_report_is_job CHECK (report_version_id IS NULL OR scope = 'job'),
  CONSTRAINT portal_threads_resolved_shape CHECK ((state = 'resolved') = (resolved_at IS NOT NULL)),
  -- A target exists only while the client is waiting on the adviser.
  CONSTRAINT portal_threads_target_shape CHECK (response_target_at IS NULL OR state = 'awaiting_nzi')
);
CREATE UNIQUE INDEX portal_threads_report_version_uq ON nzi_console.portal_threads(organisation_id, report_version_id) WHERE report_version_id IS NOT NULL;
CREATE INDEX portal_threads_client_idx ON nzi_console.portal_threads(organisation_id, client_id, last_message_at DESC);
CREATE INDEX portal_threads_job_idx ON nzi_console.portal_threads(organisation_id, job_id) WHERE job_id IS NOT NULL;

CREATE TABLE nzi_console.portal_messages (
  organisation_id text NOT NULL,
  message_id text NOT NULL,
  thread_id text NOT NULL,
  seq integer NOT NULL CHECK (seq > 0),
  author_principal text NOT NULL CHECK (author_principal IN ('portal', 'staff')),
  author_id text NOT NULL,
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The report-page comment this message is (or came from): ties the two together exactly once.
  legacy_comment_id text,
  PRIMARY KEY (organisation_id, message_id),
  FOREIGN KEY (organisation_id, thread_id) REFERENCES nzi_console.portal_threads(organisation_id, thread_id),
  UNIQUE (organisation_id, thread_id, seq)
);
CREATE UNIQUE INDEX portal_messages_legacy_comment_uq ON nzi_console.portal_messages(organisation_id, legacy_comment_id) WHERE legacy_comment_id IS NOT NULL;

-- A portal user's read marker per thread (staff read state is the thread's own state).
CREATE TABLE nzi_console.portal_thread_reads (
  organisation_id text NOT NULL,
  thread_id text NOT NULL,
  portal_user_id text NOT NULL,
  last_read_seq integer NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, thread_id, portal_user_id),
  FOREIGN KEY (organisation_id, thread_id) REFERENCES nzi_console.portal_threads(organisation_id, thread_id),
  FOREIGN KEY (organisation_id, portal_user_id) REFERENCES nzi_console.portal_users(organisation_id, portal_user_id)
);

-- ── The response target and the report-comment bridge (one definition, used by the backfill and the live path) ──

-- Whole working days (Mon-Fri) after a moment; no public holidays: a date to look at, not an obligation.
CREATE FUNCTION nzi_console.portal_response_target(p_from timestamptz) RETURNS timestamptz
  LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE d timestamptz := p_from; left_days integer := 2;
BEGIN
  WHILE left_days > 0 LOOP
    d := d + interval '1 day';
    IF extract(isodow FROM d AT TIME ZONE 'UTC') < 6 THEN left_days := left_days - 1; END IF;
  END LOOP;
  RETURN d;
END;
$$;

-- Put one report-page comment into its thread (creating the Reports-tagged job thread the first time) and keep the thread's state in step.
-- Idempotent on the comment id. Runs as the caller, so the tenant's own row-level security applies.
CREATE FUNCTION nzi_console.mirror_report_comment_to_thread(p_organisation_id text, p_comment_id text) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, nzi_console AS $$
DECLARE c nzi_console.portal_report_comments%ROWTYPE; t nzi_console.portal_threads%ROWTYPE; next_seq integer;
BEGIN
  SELECT * INTO c FROM nzi_console.portal_report_comments WHERE organisation_id = p_organisation_id AND comment_id = p_comment_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM nzi_console.portal_messages WHERE organisation_id = p_organisation_id AND legacy_comment_id = p_comment_id) THEN RETURN; END IF;
  SELECT * INTO t FROM nzi_console.portal_threads WHERE organisation_id = p_organisation_id AND report_version_id = c.report_version_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO nzi_console.portal_threads (organisation_id, thread_id, client_id, scope, job_id, subject_code, title, state, started_by_principal, started_by_id, created_at, last_message_at, report_version_id)
    VALUES (p_organisation_id, 'thr-rv-' || c.report_version_id, c.client_id, 'job', c.job_id, 'reports', 'Report review', 'open', c.author_principal, c.author_id, c.created_at, c.created_at, c.report_version_id)
    RETURNING * INTO t;
  END IF;
  next_seq := t.message_count + 1;
  INSERT INTO nzi_console.portal_messages (organisation_id, message_id, thread_id, seq, author_principal, author_id, body, created_at, legacy_comment_id)
  VALUES (p_organisation_id, 'msg-' || c.comment_id, t.thread_id, next_seq, c.author_principal, c.author_id, c.body, c.created_at, c.comment_id);
  UPDATE nzi_console.portal_threads SET
    message_count = next_seq, last_message_at = GREATEST(last_message_at, c.created_at),
    state = CASE WHEN c.author_principal = 'portal' THEN 'awaiting_nzi' ELSE 'awaiting_client' END,
    resolved_at = NULL,
    response_target_at = CASE WHEN c.author_principal = 'portal' THEN nzi_console.portal_response_target(c.created_at) ELSE NULL END,
    version = version + 1
  WHERE organisation_id = p_organisation_id AND thread_id = t.thread_id;
END;
$$;

-- The report page marked the thread read: the thread's marker follows (messages up to that moment).
CREATE FUNCTION nzi_console.mirror_report_thread_read(p_organisation_id text, p_report_version_id text, p_portal_user_id text, p_at timestamptz) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, nzi_console AS $$
DECLARE tid text; upto integer;
BEGIN
  SELECT thread_id INTO tid FROM nzi_console.portal_threads WHERE organisation_id = p_organisation_id AND report_version_id = p_report_version_id;
  IF tid IS NULL THEN RETURN; END IF;
  SELECT coalesce(max(seq), 0) INTO upto FROM nzi_console.portal_messages WHERE organisation_id = p_organisation_id AND thread_id = tid AND created_at <= p_at;
  INSERT INTO nzi_console.portal_thread_reads (organisation_id, thread_id, portal_user_id, last_read_seq, last_read_at) VALUES (p_organisation_id, tid, p_portal_user_id, upto, p_at)
  ON CONFLICT (organisation_id, thread_id, portal_user_id) DO UPDATE SET last_read_seq = GREATEST(portal_thread_reads.last_read_seq, EXCLUDED.last_read_seq), last_read_at = GREATEST(portal_thread_reads.last_read_at, EXCLUDED.last_read_at);
END;
$$;

-- ── Tenancy and grants: forced row-level security; messages are append-only; nobody holds DELETE ──────────────

ALTER TABLE nzi_console.portal_thread_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.portal_thread_subjects FORCE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.portal_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.portal_threads FORCE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.portal_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.portal_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.portal_thread_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.portal_thread_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.portal_thread_subjects USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
CREATE POLICY tenant_isolation ON nzi_console.portal_threads USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
CREATE POLICY tenant_isolation ON nzi_console.portal_messages USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
CREATE POLICY tenant_isolation ON nzi_console.portal_thread_reads USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.portal_thread_subjects TO nzi_console_app;
GRANT SELECT, INSERT, UPDATE ON nzi_console.portal_threads TO nzi_console_app;
GRANT SELECT, INSERT ON nzi_console.portal_messages TO nzi_console_app;
GRANT SELECT, INSERT, UPDATE ON nzi_console.portal_thread_reads TO nzi_console_app;
REVOKE UPDATE, DELETE ON nzi_console.portal_messages FROM PUBLIC, nzi_console_app, nzi_console_worker;
REVOKE EXECUTE ON FUNCTION nzi_console.mirror_report_comment_to_thread(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION nzi_console.mirror_report_thread_read(text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nzi_console.mirror_report_comment_to_thread(text, text) TO nzi_console_app;
GRANT EXECUTE ON FUNCTION nzi_console.mirror_report_thread_read(text, text, text, timestamptz) TO nzi_console_app;

-- ── Backfill: every existing report comment into its thread, oldest first, and every existing read marker ──────

DO $$
DECLARE org text; c record;
BEGIN
  FOR org IN SELECT organisation_id FROM nzi_console.organisations ORDER BY organisation_id LOOP
    PERFORM set_config('app.organisation_id', org, true);
    FOR c IN SELECT comment_id FROM nzi_console.portal_report_comments WHERE organisation_id = org ORDER BY created_at, comment_id LOOP
      PERFORM nzi_console.mirror_report_comment_to_thread(org, c.comment_id);
    END LOOP;
    -- Historic threads carry no response target: they were not waiting on a date nobody set.
    UPDATE nzi_console.portal_threads SET response_target_at = NULL WHERE organisation_id = org AND report_version_id IS NOT NULL;
    FOR c IN SELECT report_version_id, portal_user_id, last_read_at FROM nzi_console.portal_report_thread_reads WHERE organisation_id = org LOOP
      PERFORM nzi_console.mirror_report_thread_read(org, c.report_version_id, c.portal_user_id, c.last_read_at);
    END LOOP;
  END LOOP;
  PERFORM set_config('app.organisation_id', '', true);
END $$;

COMMENT ON TABLE nzi_console.portal_threads IS 'A client conversation: subject tag, scope (client|job), owner (staff), state, surfaced response target. report_version_id marks the thread that is a report page''s comments (mirrored both ways).';
COMMENT ON TABLE nzi_console.portal_messages IS 'Append-only. Names its author by id only; a name is joined at read. legacy_comment_id ties a message to the report-page comment it is, or came from.';

COMMIT;
