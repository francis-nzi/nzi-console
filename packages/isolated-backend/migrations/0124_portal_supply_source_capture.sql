-- 0124 A portal entry records how electricity arrived, as a CRM entry already does (NZC-164, the H4 precondition).
--
-- ## Why
--
-- The T&D companion fires on `supplySource`, and "not stated" fires nothing. NZC-159 (0117) gave the scope row its
-- `supply_source` and the CRM captures it; a portal draft had nowhere to keep it. Worse than absent: the portal's
-- entry form is the shared renderer, so it already *showed* the Supply control for electricity, and the draft
-- mapping dropped the answer. NZC-164 makes this capture a hard precondition of switching companions on —
-- `companionActivationGateReal` fails CI while a category has companions on and this column does not exist.
--
-- ## What it is
--
-- One nullable column, constrained to exactly the values the scope row accepts (0117), so a value accepted here can
-- always be carried onto the row at acceptance. NULL is "not stated", as it is on the row: the CRM offers supply
-- source rather than requiring it, and making it required for electricity is part of the H4 activation work, not of
-- capture (NZC-164). Existing records stay NULL — nothing here guesses how a past entry's electricity arrived.
--
-- ## What it does not do
--
-- Switch anything on. Every category's `companions_enabled` stays false; the gate above now passes on the column's
-- existence, and the activation migration remains its own ruled step.

BEGIN;

ALTER TABLE nzi_console.portal_data_entry_records
  ADD COLUMN supply_source text
    CHECK (supply_source IS NULL OR supply_source IN
      ('grid', 'grid-renewable', 'green-tariff', 'rego', 'self-generated'));

COMMENT ON COLUMN nzi_console.portal_data_entry_records.supply_source IS
  'How the electricity in a portal entry reached the site, as the client stated it (NZC-164). The same values as job_scope_rows.supply_source (0117), carried onto the row at acceptance. NULL is not stated; the companion declines while it holds.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM nzi_console.input_spec_categories WHERE companions_enabled) THEN
    RAISE EXCEPTION '0124 expected every companion off; activation is its own ruled step (NZC-164)';
  END IF;
END $$;

COMMIT;
