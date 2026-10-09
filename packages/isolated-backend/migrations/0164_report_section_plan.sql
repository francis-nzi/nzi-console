BEGIN;

-- Reporting F-1 (ruled 9 Oct 2026: RULING-reporting-F.md Q1–Q3, Q5, Q6; RULING-reporting-RF.md R-D1(ii)) — a report's section
-- plan, and the client's report profile that seeds it.
--
-- A plan is the report's sections in order, each included or not: the composed data sections and the R2 narrative (Q6). Its
-- rules — complete, cover first, methodology last, the mandatory sections in, exclusion only once the portal honours it
-- (Q5) — live in the contracts validator every command shares; the tables guard only its shape, so the rules are not
-- restated in SQL.
--
-- Precedence (Q3): the default ← the client's active profile, which seeds a version's plan at validate ← the version's own
-- plan. A profile edited later never reaches a version already validated or published. Publish freezes the plan into the
-- composition (`report_compositions`, untouched here), so an issued report's order is part of what was issued.

-- The client's report profile (R-D1): versioned and append-only, as 0159's template is. A change writes the next version; the
-- one before stays readable; the current is the highest. Withdrawing writes a version with `active = false`, a reason and no
-- plan.
CREATE TABLE nzi_console.client_report_profiles (
  organisation_id text NOT NULL,
  client_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),

  -- Deactivate, never delete: the profile is withdrawn by a version that says so.
  active boolean NOT NULL DEFAULT true,
  section_plan jsonb CHECK (section_plan IS NULL OR jsonb_typeof(section_plan) = 'array'),
  -- "Prepared for the Board of …": words for the cover, never money (NZC-120; the contract refuses an amount).
  issuer_line text CHECK (issuer_line IS NULL OR (issuer_line = btrim(issuer_line) AND issuer_line <> '' AND char_length(issuer_line) <= 160)),
  /* Why this version exists — required to withdraw. */
  reason text CHECK (reason IS NULL OR (reason = btrim(reason) AND reason <> '')),
  set_by text NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text NOT NULL,

  PRIMARY KEY (organisation_id, client_id, version),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id),
  -- An active profile carries a plan; a withdrawal carries none.
  CONSTRAINT client_report_profiles_plan_when_active CHECK (active = (section_plan IS NOT NULL)),
  CONSTRAINT client_report_profiles_withdrawn_bare CHECK (active OR issuer_line IS NULL),
  -- A withdrawal says why.
  CONSTRAINT client_report_profiles_deactivation_reason CHECK (active OR reason IS NOT NULL)
);
CREATE INDEX client_report_profiles_current_idx ON nzi_console.client_report_profiles (organisation_id, client_id, version DESC);

ALTER TABLE nzi_console.client_report_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_report_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_report_profiles
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
-- Append-only: a change is a new version, never an edit of the one before it.
GRANT SELECT, INSERT ON nzi_console.client_report_profiles TO nzi_console_app;
REVOKE UPDATE, DELETE ON nzi_console.client_report_profiles FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

-- A report version's plan, set at validate and changeable while validated (Q2, `report.sectionPlan.update`, which bumps the
-- version); `section_plan_origin` says where it came from. Existing versions keep NULL, which is the default plan — nothing
-- moves and nothing is backfilled. The client's issuer line, frozen at validate beside the organisation's issuer (0143).
ALTER TABLE nzi_console.report_versions
  ADD COLUMN section_plan jsonb CHECK (section_plan IS NULL OR jsonb_typeof(section_plan) = 'array'),
  ADD COLUMN section_plan_origin text CHECK (section_plan_origin IS NULL OR section_plan_origin ~ '^(default|edited|profile:[1-9][0-9]*)$'),
  ADD CONSTRAINT report_versions_section_plan_pair CHECK ((section_plan IS NULL) = (section_plan_origin IS NULL)),
  ADD COLUMN client_issuer_line text CHECK (client_issuer_line IS NULL OR (client_issuer_line = btrim(client_issuer_line) AND client_issuer_line <> '' AND char_length(client_issuer_line) <= 160));

COMMIT;
