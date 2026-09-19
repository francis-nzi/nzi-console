-- 0096 A category a client does not see, and the record of who decided that (NZC-110).
--
-- Every emission category in the governed input spec is client-visible by default. A consultant may
-- turn one off for one client — a category the client does not collect, or has agreed is out of
-- scope this year — and what this table stores is not the hiding, it is the *decision* to hide.
--
-- ## Why a row exists at all when the default is "visible"
--
-- The absence of a category from a client's portal has two possible causes, and the CRM has to be
-- able to tell them apart: nobody has set it up yet, or a consultant decided. Those call for
-- different conversations. If hiding were implemented by simply not sending the category, both
-- would look identical from the outside and the second would be unanswerable — a client asking
-- "why can't I see business travel?" would get a shrug. A row here is what makes the answer
-- retrievable: who decided, when, and the note they left.
--
-- So a row is written only when somebody decides. No row means the default, which is visible.
--
-- ## Not a column on the spec
--
-- `input_spec_categories` (0093) is global — no organisation_id, primary key `category_code`, one
-- copy shared by every firm and every client (NZC-102). A visibility column there would make one
-- client's decision everyone's. This is per client, per category, and tenant-scoped like everything
-- else that is.
--
-- ## How it composes with the grants that already exist
--
-- `portal_data_entry_bucket_grants` (0026) is deny-by-default: a portal user sees a row only where a
-- consultant granted it. This is default-on and only ever subtracts. Effective visibility is
-- `granted AND category-on` — never OR. A category turned off hides its rows whatever grants exist,
-- because the stricter decision wins; and default-on weakens nothing, because a brand-new row is
-- still invisible until it is granted.

BEGIN;

CREATE TABLE nzi_console.client_category_visibility (
  organisation_id text NOT NULL,
  client_id text NOT NULL,
  -- The governed spec's category code. Deliberately not a foreign key to `input_spec_categories`:
  -- that table is global and unscoped, and a decision recorded against a category that is later
  -- retired must stay readable — the decision happened.
  category_code text NOT NULL CHECK (nullif(btrim(category_code), '') IS NOT NULL),
  visible boolean NOT NULL,
  -- Why, in the consultant's words. Optional, because a decision is recorded whether or not it is
  -- explained, and an empty note is more honest than a required one nobody means.
  note text NOT NULL DEFAULT '',
  -- Superseded rather than removed: a decision that was in force stays in the record.
  active boolean NOT NULL DEFAULT true,
  decided_by text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, client_id, category_code),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id) ON DELETE CASCADE
);

COMMENT ON TABLE nzi_console.client_category_visibility IS
  'Per-client, per-category disclosure decisions. Default is visible, so a row exists only where somebody decided otherwise — and the row is what lets the CRM answer "why does this client not see that category?" rather than shrug.';
COMMENT ON COLUMN nzi_console.client_category_visibility.visible IS
  'The decision. false hides the category from this client''s portal regardless of any data-entry grant; true records a decision to show it, which is the default restated deliberately.';
COMMENT ON COLUMN nzi_console.client_category_visibility.active IS
  'Deactivated rather than deleted when a decision is withdrawn, so the record of having decided survives the decision.';

-- Every read is "what does this client see", resolved once per screen.
CREATE INDEX client_category_visibility_client_idx
  ON nzi_console.client_category_visibility(organisation_id, client_id) WHERE active;

ALTER TABLE nzi_console.client_category_visibility ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_category_visibility FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_category_visibility
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

GRANT SELECT, INSERT, UPDATE ON nzi_console.client_category_visibility TO nzi_console_app;
REVOKE DELETE ON nzi_console.client_category_visibility FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

COMMIT;
