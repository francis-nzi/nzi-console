BEGIN;

SET search_path TO nzi_console, public;

-- Synthetic demonstration records only. These names are fictional and contain
-- no contact details, copied notes, uploaded files, credentials, or live IDs.
INSERT INTO organisations (organisation_id, name)
VALUES ('demo-nzi-console', 'NZI Console Synthetic Demonstrator')
ON CONFLICT (organisation_id) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO clients (
  organisation_id, client_id, name, status, sector, location, owner_name, member_since,
  latest_footprint_tco2e, yoy_percent, completeness_percent, next_report_due_label,
  contact_name, contact_role, contact_email
) VALUES
  ('demo-nzi-console', 'bushy-tails', 'Bushy Tails Ltd', 'active', 'Consumer goods', 'Manchester, UK', 'A. Shaw', 2023, 1842, -7.4, 92, '31 Mar 2027', 'Sustainability Team', 'Sustainability lead', 'bushy-tails@synthetic.invalid'),
  ('demo-nzi-console', 'cedar-crane', 'Cedar & Crane Architects', 'active', 'Professional services', 'London, UK', 'A. Shaw', 2023, 412, -11.0, 96, '31 Jul 2027', 'Sustainability Team', 'ESG contact', 'cedar-crane@synthetic.invalid'),
  ('demo-nzi-console', 'verdant-foods', 'Verdant Foods Co', 'active', 'Food & beverage', 'Bristol, UK', 'M. Osei', 2024, 9210, 1.2, 74, '30 Jun 2027', 'Sustainability Team', 'Operations contact', 'verdant-foods@synthetic.invalid'),
  ('demo-nzi-console', 'quaymed-devices', 'Quaymed Devices', 'onboarding', 'Medical devices', 'Galway, IE', 'M. Osei', 2026, NULL, NULL, 34, 'Baseline in progress', 'Sustainability Team', 'Quality & ESG', 'quaymed-devices@synthetic.invalid'),
  ('demo-nzi-console', 'harbourline-logistics', 'Harbourline Logistics', 'active', 'Transport & logistics', 'Rotterdam, NL', 'A. Shaw', 2022, 18400, -3.1, 88, '30 Apr 2027', 'Sustainability Team', 'HSE contact', 'harbourline@synthetic.invalid')
ON CONFLICT (organisation_id, client_id) DO UPDATE
SET name = EXCLUDED.name, status = EXCLUDED.status, sector = EXCLUDED.sector, location = EXCLUDED.location,
    owner_name = EXCLUDED.owner_name, member_since = EXCLUDED.member_since,
    latest_footprint_tco2e = EXCLUDED.latest_footprint_tco2e, yoy_percent = EXCLUDED.yoy_percent,
    completeness_percent = EXCLUDED.completeness_percent, next_report_due_label = EXCLUDED.next_report_due_label,
    contact_name = EXCLUDED.contact_name, contact_role = EXCLUDED.contact_role, contact_email = EXCLUDED.contact_email,
    version = clients.version + 1, updated_at = now()
WHERE (clients.name, clients.status, clients.sector, clients.location, clients.owner_name, clients.member_since,
       clients.latest_footprint_tco2e, clients.yoy_percent, clients.completeness_percent,
       clients.next_report_due_label, clients.contact_name, clients.contact_role, clients.contact_email)
  IS DISTINCT FROM
      (EXCLUDED.name, EXCLUDED.status, EXCLUDED.sector, EXCLUDED.location, EXCLUDED.owner_name, EXCLUDED.member_since,
       EXCLUDED.latest_footprint_tco2e, EXCLUDED.yoy_percent, EXCLUDED.completeness_percent,
       EXCLUDED.next_report_due_label, EXCLUDED.contact_name, EXCLUDED.contact_role, EXCLUDED.contact_email);

-- Reserve the already-established demonstrator range while retaining the one
-- global counter used by every family. Future allocations begin at J000717.
UPDATE job_number_counter SET last_sequence = GREATEST(last_sequence, 716) WHERE singleton = true;

INSERT INTO jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year, owner_name, start_date, due_date, quote_id, progress_percent, detail_json) VALUES
  ('demo-nzi-console', '712', 'bushy-tails', 712, 'crp', '2024 Carbon Reduction Plan', 'open', 'Data entry', 2024, 'A. Shaw', '2026-01-06', '2026-03-31', 'Q-2026-188', 66, '{"kind":"crp","reportingPeriod":"1 Jan–31 Dec 2024","includedScopes":["1","2","3"],"reviewedRows":142,"totalRows":214}'),
  ('demo-nzi-console', '713', 'cedar-crane', 713, 'consultancy', 'Net-zero strategy support', 'open', 'Delivery', NULL, 'M. Osei', '2026-02-03', '2026-05-30', NULL, 45, '{"kind":"consultancy","scope":"Develop an operational net-zero roadmap","deliverables":["Discovery workshop","Roadmap","Board presentation"],"plannedDays":18,"usedDays":8}'),
  ('demo-nzi-console', '714', 'verdant-foods', 714, 'lca', 'Packaging life cycle assessment', 'open', 'Inventory', NULL, 'A. Shaw', '2026-02-10', '2026-06-20', NULL, 38, '{"kind":"lca","assessment":"Recyclable food packaging","boundary":"Cradle-to-grave","bomLines":34,"scenarios":3}'),
  ('demo-nzi-console', '715', 'quaymed-devices', 715, 'pcf', 'Device product carbon footprint', 'open', 'Factor mapping', NULL, 'M. Osei', '2026-02-17', '2026-06-30', NULL, 52, '{"kind":"pcf","product":"QMD Diagnostic Unit","functionalUnit":"One device over service life","bomLines":86,"readinessPct":71}'),
  ('demo-nzi-console', '716', 'harbourline-logistics', 716, 'training', 'Carbon literacy cohort', 'open', 'Delivery', NULL, 'A. Shaw', '2026-03-01', '2026-04-15', NULL, 60, '{"kind":"training","course":"Carbon Literacy for Operations","sessions":4,"bookings":28,"attendancePct":89}')
ON CONFLICT (organisation_id, job_id) DO UPDATE
SET client_id = EXCLUDED.client_id, sequence = EXCLUDED.sequence, job_family = EXCLUDED.job_family, title = EXCLUDED.title,
    status = EXCLUDED.status, workflow_stage = EXCLUDED.workflow_stage, reporting_year = EXCLUDED.reporting_year,
    owner_name = EXCLUDED.owner_name, start_date = EXCLUDED.start_date, due_date = EXCLUDED.due_date,
    quote_id = EXCLUDED.quote_id, progress_percent = EXCLUDED.progress_percent, detail_json = EXCLUDED.detail_json,
    version = jobs.version + 1, updated_at = now()
WHERE (jobs.client_id, jobs.sequence, jobs.job_family, jobs.title, jobs.status, jobs.workflow_stage,
       jobs.reporting_year, jobs.owner_name, jobs.start_date, jobs.due_date, jobs.quote_id, jobs.progress_percent, jobs.detail_json)
  IS DISTINCT FROM (EXCLUDED.client_id, EXCLUDED.sequence, EXCLUDED.job_family, EXCLUDED.title, EXCLUDED.status,
                    EXCLUDED.workflow_stage, EXCLUDED.reporting_year, EXCLUDED.owner_name, EXCLUDED.start_date,
                    EXCLUDED.due_date, EXCLUDED.quote_id, EXCLUDED.progress_percent, EXCLUDED.detail_json);

COMMIT;
