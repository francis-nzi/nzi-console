-- 0120 The switches that decide, per category, whether the write path resolves a factor declaratively
-- (Stop 2, slice 2a).
--
-- ## Rails, dark
--
-- The write path now carries the code that consumes the declarative resolver (NZC-149 onwards), inside the
-- governing command's transaction. Whether it runs for a category is this column, and **every category starts
-- off**. With nothing enabled the write path does exactly what it did before — the characterisation (NZC-160)
-- is unchanged, which is how that is proved rather than claimed. Enabling a category is its own reviewed
-- migration, one slice at a time (2b electricity, 2c the vehicle flow), each sized against staging first so
-- the number of rows it would refuse is known before it is switched on.
--
-- ## Two switches, because the companion is held
--
-- `declarative_resolution_enabled` — the primary factor is resolved and the F1 rule applies: filled when the
-- caller sent none, accepted when it matches, refused when it differs (a deliberate override or client
-- factor may differ, and must still be a factor the row may carry).
--
-- `companions_enabled` — whether the category's companion rows (transmission and distribution, NZC-154) are
-- created. Separate so electricity's primary can go live while its companion waits on the manual-3.3
-- coexistence decision (NZC-160 H4). It cannot be on without the primary: a companion is proposed only beside
-- a resolved primary, so the pair on its own would be a switch that does nothing while claiming to be on.
--
-- ## Who may flip them
--
-- Nobody but a migration. 0093 already withholds INSERT/UPDATE/DELETE on this table from the application role,
-- so enabling cannot happen from a screen, a script with app credentials, or by accident — it is a reviewed
-- change with a number on it.

BEGIN;

ALTER TABLE nzi_console.input_spec_categories
  ADD COLUMN declarative_resolution_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN companions_enabled boolean NOT NULL DEFAULT false,
  -- NOT NULL on both, so this cannot be the NULL-admitting disjunction (NZC-155): it is two booleans.
  ADD CONSTRAINT input_spec_categories_companions_need_primary
    CHECK (NOT companions_enabled OR declarative_resolution_enabled);

COMMENT ON COLUMN nzi_console.input_spec_categories.declarative_resolution_enabled IS
  'Whether the write path resolves this category''s primary factor declaratively (Stop 2). Off by default; enabled only by a reviewed migration, after sizing what it would refuse.';
COMMENT ON COLUMN nzi_console.input_spec_categories.companions_enabled IS
  'Whether this category''s companion rows are created. Requires declarative_resolution_enabled. Held off for transmission and distribution until manual 3.3 coexistence is decided (NZC-160 H4).';

-- Rails, not a rollout: this migration enables nothing, and says so if it somehow would.
DO $$
DECLARE enabled integer;
BEGIN
  SELECT count(*) INTO enabled FROM nzi_console.input_spec_categories
   WHERE declarative_resolution_enabled OR companions_enabled;
  IF enabled <> 0 THEN
    RAISE EXCEPTION '0120 lays the switches down off; % categories are enabled after it ran.', enabled;
  END IF;
END $$;

COMMIT;
