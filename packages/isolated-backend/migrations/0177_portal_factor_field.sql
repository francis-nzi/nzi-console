-- 0177 The client picks the factor for their own entry (portal data-entry phase 2; RULING-portal-dataentry-02 §A2, settled
-- 22 Oct 2026 — `_handoff/portal-dataentry-phase2-GROUNDING.md`, point 10).
--
-- ## Why
--
-- Under the records model a client never chose a factor: a staff-made bucket grant (0026) authorised one per scope row, and the
-- governed input spec (0093) showed the `factor` field to the CRM audience only. Phase 2 retires bucket grants — the client
-- enters on the job's own scope rows, "picking factors the way staff do" — so the client's entry form must offer the factor
-- field. This migration adds the portal audience to that one field, on every category, and nothing else.
--
-- ## What does not change
--
-- The write's rules are untouched and still decide what is stored: the category's declared factor (Stop 2b; the form pre-selects
-- it), applicability filing and the variant-base refusal, the JW-9 rule that a category entry needs an active factor in a dataset
-- selected for the job, and the unit check (NZC-146). Quality tier, data confidence and usage type stay CRM-only: those are
-- staff's to set, and the portal write refuses them whatever is sent (`PORTAL_STAFF_ONLY_FIELDS`). A portal hint variant says
-- what the pre-selection is; the CRM's own label, hint and lean variant are kept as they are.
--
-- Guarded as 0165 is: it refuses to run over a spec that has drifted from what was surveyed, and asserts the result.

BEGIN;

DO $$
BEGIN
  IF (SELECT count(*) FROM nzi_console.input_spec_fields f JOIN nzi_console.input_spec_categories c USING (category_code)
       WHERE f.field_key = 'factor' AND f.active AND c.active) <> (SELECT count(*) FROM nzi_console.input_spec_categories WHERE active)
     OR EXISTS (SELECT 1 FROM nzi_console.input_spec_fields WHERE field_key = 'factor' AND active
                 AND when_audiences IS DISTINCT FROM ARRAY['crm']) THEN
    RAISE EXCEPTION '0177: the factor field is not CRM-only on every category as surveyed; refusing to overwrite a drifted spec.';
  END IF;

  UPDATE nzi_console.input_spec_fields
     SET when_audiences = ARRAY['crm', 'portal'],
         -- In the seed's own variant shape (all three axes named), as `inputSpec.seed.json` carries it.
         label_variants = label_variants || '[{"audience":"portal","mode":"new","lean":false,"hint":"Set to this category''s usual factor. Change it only if your adviser has asked you to."},{"audience":"portal","mode":"existing","lean":false,"hint":"Set to this category''s usual factor. Change it only if your adviser has asked you to."}]'::jsonb,
         version = version + 1, updated_at = now(), updated_by = 'migration:0177'
   WHERE field_key = 'factor' AND active;

  IF EXISTS (SELECT 1 FROM nzi_console.input_spec_fields WHERE field_key = 'factor' AND active AND when_audiences IS DISTINCT FROM ARRAY['crm', 'portal'])
     OR EXISTS (SELECT 1 FROM nzi_console.input_spec_fields WHERE field_key IN ('qualityTier', 'dataConfidence', 'usageType') AND active
                 AND when_audiences IS DISTINCT FROM ARRAY['crm']) THEN
    RAISE EXCEPTION '0177: the spec does not read as ruled after the change.';
  END IF;
END $$;

COMMIT;
