-- 0189 SRS S3: AI ideas for bridging a readiness gap — stored, labelled, shown to the client, never applied
-- (BUILD-srs-S3-gaps-ai-and-pdf, R1–R4, R8).
--
-- For a requirement below its target, a consultant may ask for ideas from AI. They are kept here so the client sees the
-- same ideas in their portal (the settled decision, 26 Oct) — labelled as AI-generated, framed as examples — and so the
-- consultant can withdraw one. **Nothing here is a plan action or a library entry.** An idea becomes real only through
-- a person: the client proposes it (A2) and staff approve, or staff create the bridging action themselves; promotion to
-- the library stays staff-gated (A2, R3). There is no path from this table to `client_strategies` or the library.
--
-- What is stored is what was shown: the idea's title and how it bridges the requirement, already checked to carry no
-- figure and no claim (`groundSrsSuggestion`). Not the prompt: `prompt_sha256` identifies the exact request (the audit
-- trail records it by reference) without keeping a copy of what was sent. `model` names the model that answered.
--
-- One generation at a time per gap: asking again withdraws the ideas shown before (`status = 'withdrawn'`), never deletes
-- them, so the record of what a client was shown stands.

BEGIN;

CREATE TABLE nzi_console.srs_gap_suggestions (
  organisation_id text NOT NULL,
  suggestion_id text NOT NULL,
  client_id text NOT NULL,
  assessment_id text NOT NULL,
  requirement_id text NOT NULL,
  title text NOT NULL CHECK (char_length(trim(title)) BETWEEN 4 AND 90),
  how text NOT NULL CHECK (char_length(trim(how)) BETWEEN 12 AND 280),
  -- The figure rule, held by the database as well as the command: no digit, currency or percent sign reaches a client.
  CONSTRAINT srs_gap_suggestions_no_figures CHECK (title !~ '[0-9£$€¥%]' AND how !~ '[0-9£$€¥%]'),
  model text NOT NULL,
  prompt_sha256 text NOT NULL CHECK (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'shown' CHECK (status IN ('shown', 'withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  withdrawn_at timestamptz,
  withdrawn_by text,
  CONSTRAINT srs_gap_suggestions_withdrawn_shape CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL AND withdrawn_by IS NOT NULL)),
  PRIMARY KEY (organisation_id, suggestion_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients (organisation_id, client_id),
  FOREIGN KEY (organisation_id, assessment_id) REFERENCES nzi_console.srs_assessments (organisation_id, assessment_id)
);
CREATE INDEX srs_gap_suggestions_shown_idx ON nzi_console.srs_gap_suggestions (organisation_id, client_id, requirement_id)
  WHERE status = 'shown';

COMMENT ON TABLE nzi_console.srs_gap_suggestions IS
  'SRS S3: AI ideas for bridging a readiness gap, as shown to staff and the client — labelled, withdrawable, never applied. Not plan actions and not library entries; a person turns an idea into either.';
COMMENT ON COLUMN nzi_console.srs_gap_suggestions.prompt_sha256 IS
  'The exact request that produced the idea, by reference: the SHA-256 of the prompt sent. The prompt itself is not kept.';

ALTER TABLE nzi_console.srs_gap_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.srs_gap_suggestions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.srs_gap_suggestions
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

-- Stored once and then only ever withdrawn: no DELETE, and no update to what was shown.
GRANT SELECT, INSERT ON nzi_console.srs_gap_suggestions TO nzi_console_app;
GRANT UPDATE (status, withdrawn_at, withdrawn_by) ON nzi_console.srs_gap_suggestions TO nzi_console_app;

COMMIT;
