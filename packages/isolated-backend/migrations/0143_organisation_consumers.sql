-- 0143 Organisation consumers (admin Phase D, D3a; ruled `phaseD3-plan.md`, Q1–Q7).
--
-- ## What it adds
--
-- 1. **The issuer, frozen onto what is issued** (Q2), the pattern `report_versions.client_logo_asset_id` set:
--    - `report_versions.issuer_display_name / issuer_short_name / issuer_footer / issuer_logo_asset_id`, set by
--      `report.validate` from the organisation profile at that moment; the composition frozen at publish carries them
--      as its `issuer` block. **Pre-D3 versions are backfilled to exactly what they printed** — the cover and the print
--      footer said "Net Zero International", the brand mark was the "N" monogram, and "NZI" was the short form — so an
--      old report renders unchanged.
--    - `training_certificates.issuer_name`, set by `training.certificate.issue`; pre-D3 certificates backfilled
--      "Net Zero International" (what the verify page said), then NOT NULL.
--    - `verify_training_certificate()` replaced to return the certificate's own issuer instead of the literal. Same
--      signature, same body otherwise; `CREATE OR REPLACE` keeps its owner (`nzi_console_definer`, 0104), SECURITY
--      DEFINER and EXECUTE grants. Pre-flight on staging: the migration role (`postgres`) is a member of the owner.
-- 2. **The short name** (Q1): `organisation_profiles.short_name`, set to "NZI" for `net-zero-international`.
-- 3. **Currency-agnostic turnover** (C): `unit_kind` ('text' | 'currency') on `client_intensity_metrics` and
--    `organisation_intensity_metric_defaults`. The standard `turnover` rows are classified `currency`: a currency
--    metric stores no symbol — its denominator is whole units of the client's currency, and the display derives
--    "per £m" / "per €m" from the currency at the point of display (D3c). History is re-labelled, not re-valued.
-- 4. **The one carried-across turnover value** (Q6): 0071 copied the intensity target's denominator — recorded in £m —
--    into a metric that reads whole units against a divider of 1,000,000, so its intensity was a million times too
--    large. Scaled ×1,000,000 here, precisely identified, each corrected row printed below (RAISE NOTICE) and noted on
--    the row itself.
--
-- The one client stored with the non-ISO currency "UAE" is **not** changed here (Q5): the display reads it as AED, and
-- the stored value is corrected by a governed client.update.

BEGIN;

-- ── 1. The issuer, frozen ───────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE nzi_console.report_versions
  ADD COLUMN issuer_display_name text,
  ADD COLUMN issuer_short_name text,
  ADD COLUMN issuer_footer text,
  ADD COLUMN issuer_logo_asset_id text,
  ADD CONSTRAINT report_versions_issuer_logo_fk
    FOREIGN KEY (organisation_id, issuer_logo_asset_id) REFERENCES nzi_console.organisation_logo_assets (organisation_id, asset_id);

COMMENT ON COLUMN nzi_console.report_versions.issuer_display_name IS
  'The organisation''s display name as it stood when this version was validated — what the document prints, whatever the profile says later.';

UPDATE nzi_console.report_versions
   SET issuer_display_name = 'Net Zero International', issuer_short_name = 'NZI', issuer_footer = 'Net Zero International'
 WHERE issuer_display_name IS NULL;

ALTER TABLE nzi_console.training_certificates ADD COLUMN issuer_name text;
UPDATE nzi_console.training_certificates SET issuer_name = 'Net Zero International' WHERE issuer_name IS NULL;
ALTER TABLE nzi_console.training_certificates
  ALTER COLUMN issuer_name SET NOT NULL,
  ADD CONSTRAINT training_certificates_issuer_name_check CHECK (btrim(issuer_name) <> '');

CREATE OR REPLACE FUNCTION nzi_console.verify_training_certificate(p_verify_code text)
RETURNS TABLE (
  person_name text, course_name text, completed_on date, attendance_pct numeric,
  certificate_number text, issued_on date, status text, revoked_on date, issuer text
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = nzi_console, pg_temp AS $$
  SELECT b.person_name,
         coalesce(p.product_name, r.run_name, 'Training'),
         (SELECT max(s.session_date) FROM nzi_console.training_course_sessions s
           WHERE (s.organisation_id, s.course_run_id) = (r.organisation_id, r.course_run_id) AND s.status = 'delivered'),
         c.attendance_pct,
         c.certificate_number,
         c.issued_at::date,
         c.status,
         c.revoked_at::date,
         c.issuer_name
  FROM nzi_console.training_certificates c
  JOIN nzi_console.training_bookings b ON (b.organisation_id, b.booking_id) = (c.organisation_id, c.booking_id)
  JOIN nzi_console.training_course_runs r ON (r.organisation_id, r.course_run_id) = (c.organisation_id, c.course_run_id)
  LEFT JOIN nzi_console.training_products p ON (p.organisation_id, p.training_product_id) = (r.organisation_id, r.training_product_id)
  WHERE c.verify_code = p_verify_code;
$$;

-- ── 2. The short name ───────────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE nzi_console.organisation_profiles
  ADD COLUMN short_name text CHECK (short_name IS NULL OR (short_name = btrim(short_name) AND short_name <> '' AND length(short_name) <= 20));

UPDATE nzi_console.organisation_profiles
   SET short_name = 'NZI', version = version + 1, updated_at = now(), updated_by = 'migration:0143'
 WHERE organisation_id = 'net-zero-international' AND short_name IS NULL;

-- ── 3. Currency-agnostic turnover ───────────────────────────────────────────────────────────────────────────────

ALTER TABLE nzi_console.client_intensity_metrics
  ADD COLUMN unit_kind text NOT NULL DEFAULT 'text' CHECK (unit_kind IN ('text', 'currency'));
ALTER TABLE nzi_console.organisation_intensity_metric_defaults
  ADD COLUMN unit_kind text NOT NULL DEFAULT 'text' CHECK (unit_kind IN ('text', 'currency'));

COMMENT ON COLUMN nzi_console.client_intensity_metrics.unit_kind IS
  'currency: the denominator is whole units of the client''s currency and the display derives its symbol (per £m, per €m); unit_wording is then informational. text: unit_wording is the unit.';

UPDATE nzi_console.client_intensity_metrics SET unit_kind = 'currency' WHERE metric_key = 'turnover' AND is_standard;
UPDATE nzi_console.organisation_intensity_metric_defaults SET unit_kind = 'currency' WHERE metric_key = 'turnover' AND is_standard;

-- ── 4. The one carried-across turnover value (Q6) ───────────────────────────────────────────────────────────────

DO $$
DECLARE
  corrected record;
  total integer := 0;
BEGIN
  FOR corrected IN
    UPDATE nzi_console.job_intensity_values
       SET value = value * 1000000,
           version = version + 1,
           note = note || ' Scaled ×1,000,000 by migration 0143: carried across in £m, read against a divider of 1,000,000 as whole units.'
     WHERE metric_key = 'turnover' AND note LIKE 'Carried across%' AND value < 1000
    RETURNING organisation_id, job_id, reporting_year, period_key, value / 1000000 AS was, value AS now
  LOOP
    total := total + 1;
    -- Traceable in the database too, not only in the deploy log: one audit event per corrected value.
    INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, before_json, after_json)
    VALUES (corrected.organisation_id, gen_random_uuid()::text, 'migration:0143', 'system', 'job.intensity_value.corrected', 'job', corrected.job_id, 'migration:0143',
      'Turnover carried across by 0071 in £m, read as whole units against a divider of 1,000,000; scaled ×1,000,000 (ruled phaseD3-plan Q6).',
      jsonb_build_object('metricKey', 'turnover', 'reportingYear', corrected.reporting_year, 'periodKey', corrected.period_key, 'value', corrected.was),
      jsonb_build_object('metricKey', 'turnover', 'reportingYear', corrected.reporting_year, 'periodKey', corrected.period_key, 'value', corrected.now));
    RAISE NOTICE '0143 corrected turnover: organisation % · job % · % % · % → %',
      corrected.organisation_id, corrected.job_id, corrected.reporting_year, corrected.period_key, corrected.was, corrected.now;
  END LOOP;
  RAISE NOTICE '0143 corrected % carried-across turnover value(s)', total;
END;
$$;

COMMIT;
