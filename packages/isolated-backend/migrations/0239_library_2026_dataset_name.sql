-- 0239 The 2026 editions' recorded name (PLAN-library-2026-dataset-name, approved 26 Nov).
--
-- DESNZ's 2026 edition and NZI's (V7 datasets 69+70) were loaded under the name of the temp file V7's upload went through,
-- "tmpai4mgnde.csv": the loader takes a dataset's name from V7's own file_name. Both are now named for what they are.
--
-- The name only. The version stays "tmpai4mgnde.csv", as V7 recorded it: it is provenance (factor set + version), cited by
-- rows' provenance and lineage and by frozen snapshots, and rewriting it would leave them citing a version that no longer
-- matches. The name is not in the dataset's content hash, so a re-load leaves this correction in place.
--
-- Idempotent and narrow: only these two datasets, only while they still carry the temp name; a database without them is
-- untouched.

BEGIN;

UPDATE nzi_console.emission_factor_datasets
   SET name = 'DESNZ GHG Conversion Factors 2026'
 WHERE dataset_id IN ('uk-ghg-gb-2026', 'nzi-gb-2026')
   AND legacy_dataset_id = '69+70'
   AND name = 'tmpai4mgnde.csv';

COMMIT;
