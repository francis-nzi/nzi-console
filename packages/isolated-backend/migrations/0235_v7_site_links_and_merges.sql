-- 0235 One console site per V7 site, and duplicate sites merged (SWEEP-v7-duplicate-sites.md; ruled 25 Nov 2026).
--
-- The 29 Sep import suffixed a V7 site name repeated within one client with " (v7 site N)", minting a second console site for
-- what is one place (J000434's Langtons). The rulings:
--   1. Survivor: the site with entries keeps them and loses the suffix; where neither has entries, the unsuffixed site survives.
--      No rows move, except Bryson Tractors (ruled: both had entries; the 2 rows move to the 31-row site, each audited).
--   2. Mapping: a new append-only table maps each V7 site to its console site. Every load, re-sync and bring-in resolves a V7
--      site through it.
--   3. Retire: the duplicate is archived and records what it merged into; audited; never deleted.
--   The importer maps a V7 site to a same-named site on the client before creating one, and a name never carries
--   "(v7 site N)" again. A nameless V7 site with rows imports flagged for naming; one with no rows imports archived.
--
-- This migration is the schema and the mapping's backfill only. The merges themselves are the owner's run, after merge
-- (scripts/v7-merge-duplicate-sites.ts: a dry run by default, --commit to write).

BEGIN;

-- ── 1. The V7 site → console site mapping ──────────────────────────────────────────────────────────────────────────
-- Append-only: a V7 site's current console site is its latest link (the highest link_no). A merge re-points by appending.
CREATE TABLE nzi_console.v7_site_links (
  organisation_id text NOT NULL,
  link_no bigint GENERATED ALWAYS AS IDENTITY,
  v7_site_id text NOT NULL CHECK (v7_site_id ~ '^[0-9]+$'),
  site_id text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('backfill', 'import', 'name-match', 'merge')),
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  correlation_id text NOT NULL CHECK (btrim(correlation_id) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, link_no),
  FOREIGN KEY (organisation_id, site_id) REFERENCES nzi_console.client_sites(organisation_id, site_id)
);
CREATE INDEX v7_site_links_current ON nzi_console.v7_site_links (organisation_id, v7_site_id, link_no DESC);

CREATE FUNCTION nzi_console.v7_site_links_are_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'v7_site_links is append-only'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'v7_site_links_are_append_only';
END;
$$;
CREATE TRIGGER v7_site_links_are_append_only BEFORE UPDATE OR DELETE ON nzi_console.v7_site_links
  FOR EACH ROW EXECUTE FUNCTION nzi_console.v7_site_links_are_append_only();

COMMENT ON TABLE nzi_console.v7_site_links IS
  'Each V7 site''s console site (0235). The current link is the highest link_no per V7 site; a merge appends a new one. Append-only.';

-- Every site the import created is its own V7 site's console site.
INSERT INTO nzi_console.v7_site_links (organisation_id, v7_site_id, site_id, reason, created_by, correlation_id)
SELECT organisation_id, legacy_db_id, site_id, 'backfill', 'migration:0235', 'migration:0235'
  FROM nzi_console.client_sites
 WHERE source_system = 'nzi-pro-v7' AND legacy_db_id ~ '^[0-9]+$'
 ORDER BY organisation_id, legacy_db_id::bigint;

ALTER TABLE nzi_console.v7_site_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.v7_site_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.v7_site_links
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
REVOKE ALL ON nzi_console.v7_site_links FROM PUBLIC;
GRANT SELECT, INSERT ON nzi_console.v7_site_links TO nzi_console_app;

-- ── 2. A retired duplicate, and a name awaiting one ────────────────────────────────────────────────────────────────
ALTER TABLE nzi_console.client_sites
  ADD COLUMN merged_into_site_id text,
  ADD COLUMN name_needs_review boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT client_sites_merged_into_fk
    FOREIGN KEY (organisation_id, merged_into_site_id) REFERENCES nzi_console.client_sites(organisation_id, site_id),
  ADD CONSTRAINT client_sites_merged_is_retired
    CHECK (merged_into_site_id IS NULL OR (archived AND NOT is_registered_office AND merged_into_site_id <> site_id));

COMMENT ON COLUMN nzi_console.client_sites.merged_into_site_id IS
  'The site this one was merged into (0235): it is archived, never shown or picked again, and never deleted.';
COMMENT ON COLUMN nzi_console.client_sites.name_needs_review IS
  'The previous system holds no name for this site (0235): it carries a placeholder until named there; the next load takes the name.';

-- A retired duplicate keeps the place's name without a suffix, so the name is unique among the sites still in use.
DROP INDEX nzi_console.client_sites_name_unique;
CREATE UNIQUE INDEX client_sites_name_unique
  ON nzi_console.client_sites (organisation_id, client_id, lower(trim(name)))
  WHERE merged_into_site_id IS NULL;

-- The sites the import named "Unnamed site (v7 site N)" are flagged now; the next load takes V7's name once it has one.
UPDATE nzi_console.client_sites SET name_needs_review = true
 WHERE source_system = 'nzi-pro-v7' AND name ~ '^Unnamed site \(v7 site [0-9]+\)$';

-- ── 3. A merged site's rows move to the survivor (Bryson Tractors, ruled) ───────────────────────────────────────────
-- Migrated history stays immutable but for one change: its site may move from a retired duplicate to the site that
-- duplicate was merged into. Nothing else about the row may change in the same update.
CREATE OR REPLACE FUNCTION nzi_console.refuse_migrated_scope_row_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = nzi_console, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.origin = 'migrated' THEN
      RAISE EXCEPTION 'Scope row % is migrated history and cannot be deleted; disable it instead.', OLD.scope_row_id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.origin = 'live' AND NEW.origin <> 'live' THEN
    RAISE EXCEPTION 'Scope row % was captured here and cannot become migrated history.', OLD.scope_row_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.origin = 'migrated' AND NEW.site_id IS DISTINCT FROM OLD.site_id THEN
    IF NOT EXISTS (SELECT 1 FROM nzi_console.client_sites s
                    WHERE s.organisation_id = OLD.organisation_id AND s.site_id = OLD.site_id
                      AND s.merged_into_site_id IS NOT NULL AND s.merged_into_site_id = NEW.site_id) THEN
      RAISE EXCEPTION 'Scope row % is migrated history: its site moves only to the site its own was merged into.', OLD.scope_row_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF OLD.origin = 'migrated'
     AND (to_jsonb(NEW) - ARRAY['enabled', 'superseded_by_row_id', 'version', 'updated_at', 'site_id'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['enabled', 'superseded_by_row_id', 'version', 'updated_at', 'site_id']) THEN
    RAISE EXCEPTION 'Scope row % is migrated history: only whether it is enabled may change.', OLD.scope_row_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
