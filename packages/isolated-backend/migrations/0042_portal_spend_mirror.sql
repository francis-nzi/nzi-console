BEGIN;

-- B5 — client-portal spend mirror (NZC-036 / NZC-016). Additive and inert until
-- the `portal-spend` surface reads it.
--
--  * portal_data_entry_records gains a snapshot `entry_kind` and a nullable
--    kind-specific `detail_json` (spend line: netValue / vatPercent / glCode /
--    pgsCategoryId / invoiceDate / monthlyActivity). Existing manual rows take
--    the default and leave detail_json null.
--  * portal_data_entry_bucket_grants gains `allowed_pgs_category_ids` — the
--    controlled PG&S categories a portal user may pick for a spend-kind bucket
--    (NZC-036 D-B5-4). Empty for every non-spend kind. Validated in the grant
--    command against the job client's categories, mirroring allowed_factor_ids.

ALTER TABLE nzi_console.portal_data_entry_records
  ADD COLUMN entry_kind text NOT NULL DEFAULT 'manual_activity'
    CHECK (entry_kind IN ('manual_activity','spend','commuting','vehicle')),
  ADD COLUMN detail_json jsonb
    CHECK (detail_json IS NULL OR jsonb_typeof(detail_json) = 'object');

ALTER TABLE nzi_console.portal_data_entry_bucket_grants
  ADD COLUMN allowed_pgs_category_ids text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN nzi_console.portal_data_entry_records.detail_json IS
  'Kind-specific capture detail (NZC-035). entry_kind=spend: {netValue, vatPercent, glCode, pgsCategoryId, invoiceDate, monthlyActivity}.';
COMMENT ON COLUMN nzi_console.portal_data_entry_bucket_grants.allowed_pgs_category_ids IS
  'Controlled PG&S categories a portal user may select for a spend-kind bucket (NZC-036 D-B5-4); empty for non-spend kinds.';

COMMIT;
