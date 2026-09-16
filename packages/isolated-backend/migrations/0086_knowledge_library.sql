-- 0086 — The knowledge library: capture → approve → publish.
--
-- Every question someone asks becomes reusable, citable knowledge instead of being answered
-- once in a chat and lost. The entries here are what will ground the help AI, so the
-- integrity rules matter more than usual: an answer the AI cites must have been ratified by
-- a person, and must be traceable to who asked, who drafted it, and who approved it.
--
-- ── SCOPE: THIS IS NZI'S OWN LIBRARY, NOT PER-CLIENT DATA ────────────────────────────────
--
-- `organisation_id` here is the NZI consultancy tenant, exactly as it is everywhere else —
-- clients live INSIDE an organisation (`clients` is keyed on (organisation_id, client_id)),
-- and a staff session sets `app.organisation_id` to the user's own org, never to whichever
-- client they happen to be looking at. So the tenant policy below means "owned by NZI,
-- readable by every NZI staff member", which is the intent.
--
-- **There is deliberately no `client_id` on any table in this migration.** The library is
-- shared knowledge: an answer written while working on one client must be visible to
-- everyone. A client column would silently partition it and defeat the entire point, so the
-- absence is load-bearing and a test asserts it stays absent.
--
-- A `public` entry is the source for the future website knowledge base. Public-ness is a
-- status on the entry, not a second visibility mechanism, so that export reads
-- `status = 'public'` without any change to the policy below.
--
-- ── WHY A DRAFT IS AN ENTRY, NOT ITS OWN TABLE ───────────────────────────────────────────
--
-- A draft has the same shape as the thing it becomes. A separate table would duplicate every
-- column, need its own versioning, and require a copy step on approval — which is precisely
-- where the approved text and the reviewed text drift apart. One table, one lifecycle:
-- draft → internal → public.

BEGIN;

-- Trigram similarity, for finding near-duplicate questions before a second one is created.
-- The first extension this schema takes. It is created here rather than assumed: if the role
-- cannot create it the migration fails loudly, which is the honest outcome — silently
-- falling back to exact matching would leave duplicate detection looking present and doing
-- nothing.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE nzi_console.knowledge_entries (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  entry_id text NOT NULL,

  /* The one question this entry answers. Alternative phrasings live in the alias table and
     fold into this entry rather than becoming rivals to it. */
  canonical_question text NOT NULL CHECK (nullif(trim(canonical_question), '') IS NOT NULL),
  /* The normalised form: lowercased, punctuation stripped, whitespace collapsed. Written by
     the command, and what uniqueness and lookup are keyed on. */
  canonical_key text NOT NULL CHECK (nullif(trim(canonical_key), '') IS NOT NULL),
  answer text NOT NULL DEFAULT '',

  /* draft → internal (grounds the AI, staff-visible) → public (client-facing, website-bound). */
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','internal','public')),
  category text NOT NULL DEFAULT '',
  /* The area of the app this belongs to, so the drawer can ground page-aware. */
  area text NOT NULL DEFAULT '',

  /* What makes capture idempotent: the thing being captured FROM. In Phase 1 the answer's
     id; today a hash of the question and page. A second capture of the same thing reopens
     the same draft instead of stacking another form. */
  source_key text NOT NULL,

  /* Provenance — who asked, who wrote it, and whether a person or the AI drafted it. An
     AI-drafted answer is a draft and nothing more until someone ratifies it. */
  asked_by text NOT NULL DEFAULT '',
  drafted_by text NOT NULL,
  drafted_by_kind text NOT NULL DEFAULT 'human' CHECK (drafted_by_kind IN ('human','ai')),
  approved_by text,
  approved_at timestamptz,
  published_by text,
  published_at timestamptz,

  /* Surfaced at capture time and carried into the queue so the approver sees it. */
  possible_duplicate boolean NOT NULL DEFAULT false,
  /* Set when an entry is rejected as a duplicate of another, or merged into it. */
  duplicate_of_entry_id text,
  /* A pending edit to an already-approved entry. The approved entry stays live and keeps
     grounding the AI until this revision is approved — a correction in progress must not
     remove the answer people are relying on. */
  revises_entry_id text,

  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deactivated_by text,
  deactivated_at timestamptz,

  PRIMARY KEY (organisation_id, entry_id),
  FOREIGN KEY (organisation_id, duplicate_of_entry_id) REFERENCES nzi_console.knowledge_entries(organisation_id, entry_id),
  FOREIGN KEY (organisation_id, revises_entry_id) REFERENCES nzi_console.knowledge_entries(organisation_id, entry_id),

  /* Approval and publication stamp who and when, together or not at all. */
  CONSTRAINT knowledge_entries_approval_stamped CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CONSTRAINT knowledge_entries_publication_stamped CHECK ((published_by IS NULL) = (published_at IS NULL)),
  /* An entry cannot be past a tier it was never granted. */
  CONSTRAINT knowledge_entries_internal_approved CHECK (status = 'draft' OR approved_by IS NOT NULL),
  CONSTRAINT knowledge_entries_public_published CHECK (status <> 'public' OR published_by IS NOT NULL),
  /* Deactivation stamps who and when, as everywhere else. */
  CONSTRAINT knowledge_entries_deactivation_stamped CHECK (active OR (deactivated_by IS NOT NULL AND deactivated_at IS NOT NULL)),
  /* Only a draft may be a revision of something: once approved it IS the entry. */
  CONSTRAINT knowledge_entries_revision_is_draft CHECK (revises_entry_id IS NULL OR status = 'draft')
);

/* Hard uniqueness ONLY once approved. A raw draft string must not collide — two people
   legitimately asking the same thing in the same week would be refused, and near-duplicates
   slip an exact-string index anyway. Dedup is a surfaced, human-adjudicated step; this index
   is the backstop that stops two APPROVED entries saying the same thing. */
CREATE UNIQUE INDEX knowledge_entries_canonical_once_approved_idx
  ON nzi_console.knowledge_entries (organisation_id, canonical_key)
  WHERE status IN ('internal','public') AND active;

/* Idempotent capture, enforced by the database rather than by the command remembering to
   look: one open draft per person per captured answer. */
CREATE UNIQUE INDEX knowledge_entries_one_open_draft_idx
  ON nzi_console.knowledge_entries (organisation_id, created_by, source_key)
  WHERE status = 'draft' AND active;

CREATE INDEX knowledge_entries_status_idx ON nzi_console.knowledge_entries (organisation_id, status, active);
CREATE INDEX knowledge_entries_area_idx ON nzi_console.knowledge_entries (organisation_id, area);
/* What findSimilar searches: near-duplicate questions, by trigram. */
CREATE INDEX knowledge_entries_question_trgm_idx
  ON nzi_console.knowledge_entries USING gin (canonical_key gin_trgm_ops);

COMMENT ON TABLE nzi_console.knowledge_entries IS
  'NZI''s own knowledge library — shared across the whole consultancy, deliberately NOT partitioned per client (there is no client_id). draft -> internal (grounds the help AI) -> public (client-facing, website-bound). Versioned, provenanced, deactivated but never deleted.';
COMMENT ON COLUMN nzi_console.knowledge_entries.source_key IS
  'What this was captured from. With the partial unique index, a second capture of the same answer by the same person reopens their existing draft instead of creating a rival.';
COMMENT ON COLUMN nzi_console.knowledge_entries.revises_entry_id IS
  'A pending edit to an approved entry. The approved entry stays live and keeps grounding the AI until this revision is approved, so a correction in progress never removes the answer in use.';

-- ── Alias phrasings ──────────────────────────────────────────────────────────────────────
--
-- A rephrasing folds into the entry it matches rather than becoming a second entry. This is
-- also what makes grounding better over time: more phrasings resolve to the one approved
-- answer, so the same question stops being re-captured.

CREATE TABLE nzi_console.knowledge_entry_aliases (
  organisation_id text NOT NULL,
  entry_id text NOT NULL,
  alias_key text NOT NULL,
  alias_question text NOT NULL CHECK (nullif(trim(alias_question), '') IS NOT NULL),
  added_by text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, entry_id, alias_key),
  FOREIGN KEY (organisation_id, entry_id) REFERENCES nzi_console.knowledge_entries(organisation_id, entry_id) ON DELETE CASCADE
);

CREATE INDEX knowledge_entry_aliases_key_trgm_idx
  ON nzi_console.knowledge_entry_aliases USING gin (alias_key gin_trgm_ops);

COMMENT ON TABLE nzi_console.knowledge_entry_aliases IS
  'Alternative phrasings of an entry''s question. A re-ask folds in here rather than creating a rival entry, which is both the dedup mechanism and what improves grounding.';

-- ── Version history ──────────────────────────────────────────────────────────────────────
--
-- Append-only. A material edit supersedes, and the superseded text stays readable: an entry
-- the AI cited last month must still be explicable, and an approval means nothing if what
-- was approved can be rewritten out of existence.

CREATE TABLE nzi_console.knowledge_entry_versions (
  organisation_id text NOT NULL,
  entry_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  snapshot_json jsonb NOT NULL,
  changed_by text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  /* What happened, so the history reads without diffing two snapshots. */
  change text NOT NULL CHECK (change IN ('captured','edited','approved','published','rejected','merged','deactivated','revision-applied')),
  correlation_id text,
  PRIMARY KEY (organisation_id, entry_id, version),
  FOREIGN KEY (organisation_id, entry_id) REFERENCES nzi_console.knowledge_entries(organisation_id, entry_id) ON DELETE CASCADE
);

COMMENT ON TABLE nzi_console.knowledge_entry_versions IS
  'Append-only history of every knowledge entry. Never updated, never deleted: what an approver ratified must stay readable after it is superseded.';

-- ── Tenancy and grants ───────────────────────────────────────────────────────────────────
--
-- The standard NZI-tenant policy. It scopes to the consultancy, so every NZI staff member
-- sees the whole library regardless of which client they are working in — which is the
-- point of a shared library and the reason there is no client_id above.

ALTER TABLE nzi_console.knowledge_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.knowledge_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.knowledge_entries
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

ALTER TABLE nzi_console.knowledge_entry_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.knowledge_entry_aliases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.knowledge_entry_aliases
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

ALTER TABLE nzi_console.knowledge_entry_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.knowledge_entry_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.knowledge_entry_versions
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

GRANT SELECT, INSERT, UPDATE ON nzi_console.knowledge_entries TO nzi_console_app;
/* Deactivate-not-delete: an entry that was cited must remain explicable. */
REVOKE DELETE ON nzi_console.knowledge_entries FROM nzi_console_app;
/* Re-aliasing is an edit to an allocation, not a record to preserve — the same reasoning as
   strategy_levers in 0081. */
GRANT SELECT, INSERT, DELETE ON nzi_console.knowledge_entry_aliases TO nzi_console_app;
GRANT SELECT, INSERT ON nzi_console.knowledge_entry_versions TO nzi_console_app;
REVOKE UPDATE, DELETE ON nzi_console.knowledge_entry_versions FROM nzi_console_app;

REVOKE DELETE ON nzi_console.knowledge_entries FROM PUBLIC, nzi_console_worker, nzi_console_auth;
REVOKE UPDATE, DELETE ON nzi_console.knowledge_entry_versions FROM PUBLIC, nzi_console_worker, nzi_console_auth;

COMMIT;
