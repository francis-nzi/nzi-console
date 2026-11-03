-- Portal files, client UI (RULING-portal-files-client-ui): a fixed category a file is filed under, chosen on upload. A small closed set,
-- CHECK-constrained here and mirrored in @nzi/contracts (PORTAL_FILE_CATEGORIES); CRM-configurable categories are a later follow-up.
-- Existing rows and anything that does not choose one are 'other', so nothing already stored changes meaning and no backfill is needed.
ALTER TABLE nzi_console.portal_files
  ADD COLUMN category text NOT NULL DEFAULT 'other' CHECK (category IN ('data_evidence', 'reports', 'contracts', 'other'));
COMMENT ON COLUMN nzi_console.portal_files.category IS 'The fixed category the file is filed under (data_evidence | reports | contracts | other). Chosen on upload; other when none is.';
