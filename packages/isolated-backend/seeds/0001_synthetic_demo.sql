BEGIN;

SET search_path TO nzi_console, public;

-- Synthetic demonstration records only. These names are fictional and contain
-- no contact details, copied notes, uploaded files, credentials, or live IDs.
INSERT INTO organisations (organisation_id, name)
VALUES ('demo-nzi-console', 'NZI Console Synthetic Demonstrator')
ON CONFLICT (organisation_id) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO clients (organisation_id, client_id, name, status) VALUES
  ('demo-nzi-console', 'bushy-tails', 'Bushy Tails Ltd', 'active'),
  ('demo-nzi-console', 'cedar-crane', 'Cedar & Crane Architects', 'active'),
  ('demo-nzi-console', 'verdant-foods', 'Verdant Foods Co', 'active'),
  ('demo-nzi-console', 'quaymed-devices', 'Quaymed Devices', 'onboarding'),
  ('demo-nzi-console', 'harbourline-logistics', 'Harbourline Logistics', 'active')
ON CONFLICT (organisation_id, client_id) DO UPDATE
SET name = EXCLUDED.name, status = EXCLUDED.status, version = clients.version + 1, updated_at = now()
WHERE (clients.name, clients.status) IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.status);

-- Reserve the already-established demonstrator range while retaining the one
-- global counter used by every family. Future allocations begin at J000717.
UPDATE job_number_counter SET last_sequence = GREATEST(last_sequence, 716) WHERE singleton = true;

INSERT INTO jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage) VALUES
  ('demo-nzi-console', '712', 'bushy-tails', 712, 'crp', '2024 Carbon Reduction Plan', 'open', 'data-entry'),
  ('demo-nzi-console', '713', 'cedar-crane', 713, 'consultancy', 'Net-zero strategy support', 'open', 'delivery'),
  ('demo-nzi-console', '714', 'verdant-foods', 714, 'lca', 'Packaging life cycle assessment', 'open', 'inventory'),
  ('demo-nzi-console', '715', 'quaymed-devices', 715, 'pcf', 'Device product carbon footprint', 'open', 'factor-mapping'),
  ('demo-nzi-console', '716', 'harbourline-logistics', 716, 'training', 'Carbon literacy cohort', 'open', 'delivery')
ON CONFLICT (organisation_id, job_id) DO UPDATE
SET client_id = EXCLUDED.client_id, sequence = EXCLUDED.sequence, job_family = EXCLUDED.job_family, title = EXCLUDED.title,
    status = EXCLUDED.status, workflow_stage = EXCLUDED.workflow_stage,
    version = jobs.version + 1, updated_at = now()
WHERE (jobs.client_id, jobs.sequence, jobs.job_family, jobs.title, jobs.status, jobs.workflow_stage)
  IS DISTINCT FROM (EXCLUDED.client_id, EXCLUDED.sequence, EXCLUDED.job_family, EXCLUDED.title, EXCLUDED.status, EXCLUDED.workflow_stage);

COMMIT;
