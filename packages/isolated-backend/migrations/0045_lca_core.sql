BEGIN;

-- Job-family model batch, Phase 0 — LCA/PCF core reference data + libraries
-- (NZC-052/053/054; MODEL_FIDELITY_JOB_FAMILIES.md §2, §6). Additive and inert
-- until the LCA workspace module reads it. Follows the live nzi_pro 0058 rebuild:
-- flat inventory (no BOM tree), open module vocabulary, a reusable client-scoped
-- component/supplier library that mirrors the client_factors pattern (NZC-041).
--
-- PCF is not a separate model (NZC-052) — it is an `lca_assessments` preset
-- (standard 'ISO 14067', cradle-to-gate, modules A1–A3). The "Product Carbon
-- Footprint" term keeps its one sanctioned home there per NZC-039; the shared
-- model does not remove it.

-- EN 15804 life-cycle modules — a global standard vocabulary, not tenant data.
CREATE TABLE nzi_console.lca_modules (
  module_code text PRIMARY KEY,
  label text NOT NULL,
  description text NOT NULL DEFAULT '',
  module_group text NOT NULL CHECK (module_group IN ('product','transport','use','end_of_life','benefits')),
  sort_order integer NOT NULL DEFAULT 0,
  default_in_pcf boolean NOT NULL DEFAULT false,
  default_in_lca boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true
);
INSERT INTO nzi_console.lca_modules (module_code, label, description, module_group, sort_order, default_in_pcf, default_in_lca) VALUES
  ('A1','Raw material supply','Extraction and processing of raw materials','product',10,true,true),
  ('A2','Transport to manufacturer','Transport of raw materials to the manufacturing site','product',20,true,true),
  ('A3','Manufacturing','Manufacturing and assembly of the product','product',30,true,true),
  ('A4','Transport to site/user','Transport of the finished product to the point of use','transport',40,false,true),
  ('A5','Construction/installation','Installation or construction impacts','transport',50,false,true),
  ('B1','Use','Emissions during normal use of the product','use',60,false,true),
  ('B2','Maintenance','Emissions from maintaining the product','use',70,false,true),
  ('B3','Repair','Emissions from repairing the product','use',80,false,true),
  ('B4','Replacement','Emissions from replacing parts of the product','use',90,false,true),
  ('B5','Refurbishment','Emissions from refurbishment','use',100,false,true),
  ('B6','Operational energy use','Energy consumed during use','use',110,false,true),
  ('B7','Operational water use','Water consumed during use','use',120,false,true),
  ('C1','Deconstruction/demolition','End-of-life deconstruction','end_of_life',130,false,true),
  ('C2','Transport to waste processing','Transport of waste product to processing','end_of_life',140,false,true),
  ('C3','Waste processing','Processing of waste for recycling/recovery','end_of_life',150,false,true),
  ('C4','Disposal','Final disposal (landfill/incineration)','end_of_life',160,false,true),
  ('D','Benefits beyond system boundary','Recycling/recovery/reuse credits','benefits',170,false,true);
GRANT SELECT ON nzi_console.lca_modules TO nzi_console_app;

-- Material-category vocabulary — org-scoped (admin-editable, per live).
CREATE TABLE nzi_console.lca_material_categories (
  organisation_id text NOT NULL,
  material_category_id text NOT NULL,
  name text NOT NULL CHECK (nullif(trim(name), '') IS NOT NULL),
  description text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, material_category_id)
);
CREATE INDEX lca_material_categories_org_idx ON nzi_console.lca_material_categories(organisation_id, is_active, lower(name));
ALTER TABLE nzi_console.lca_material_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.lca_material_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.lca_material_categories USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.lca_material_categories TO nzi_console_app;

-- Reusable component library — client-scoped OR global (client_id NULL), archive
-- lifecycle; mirrors client_factors (NZC-041 / NZC-053).
CREATE TABLE nzi_console.lca_components (
  organisation_id text NOT NULL,
  component_id text NOT NULL,
  client_id text,
  component_code text,
  description text NOT NULL CHECK (nullif(trim(description), '') IS NOT NULL),
  material_category_id text,
  default_unit_mass double precision CHECK (default_unit_mass IS NULL OR default_unit_mass >= 0),
  default_unit text NOT NULL DEFAULT 'kg',
  origin_country text,
  supplier_name text,
  supplier_contact text,
  notes text NOT NULL DEFAULT '',
  archived boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  archived_by text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz,
  PRIMARY KEY (organisation_id, component_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, material_category_id) REFERENCES nzi_console.lca_material_categories(organisation_id, material_category_id)
);
CREATE INDEX lca_components_client_idx ON nzi_console.lca_components(organisation_id, client_id, archived);
CREATE INDEX lca_components_code_idx ON nzi_console.lca_components(organisation_id, client_id, component_code);
ALTER TABLE nzi_console.lca_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.lca_components FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.lca_components USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.lca_components TO nzi_console_app;

-- Reusable supplier library — client-scoped OR global.
CREATE TABLE nzi_console.lca_suppliers (
  organisation_id text NOT NULL,
  supplier_id text NOT NULL,
  client_id text,
  name text NOT NULL CHECK (nullif(trim(name), '') IS NOT NULL),
  country text,
  contact_name text,
  contact_email text,
  notes text NOT NULL DEFAULT '',
  archived boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, supplier_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id) ON DELETE CASCADE
);
CREATE INDEX lca_suppliers_client_idx ON nzi_console.lca_suppliers(organisation_id, client_id, archived);
ALTER TABLE nzi_console.lca_suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.lca_suppliers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.lca_suppliers USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.lca_suppliers TO nzi_console_app;

COMMENT ON TABLE nzi_console.lca_modules IS 'EN 15804 life-cycle modules (A1–D) — global standard vocabulary. default_in_pcf drives the PCF preset (NZC-052).';
COMMENT ON TABLE nzi_console.lca_components IS 'Reusable LCA component library, client-scoped (client_id) or global (NZC-053); mirrors client_factors.';

COMMIT;
