-- NZC-069: the console owns the immutable commercial document trail.
CREATE TABLE nzi_console.quotes (
  organisation_id text NOT NULL,
  quote_id text NOT NULL,
  client_id text NOT NULL,
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','approved','accepted','converted')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, quote_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id)
);
CREATE TABLE nzi_console.quote_versions (
  organisation_id text NOT NULL,
  quote_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL,
  total numeric(14,2) NOT NULL CHECK (total >= 0),
  currency char(3) NOT NULL,
  valid_until date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  PRIMARY KEY (organisation_id, quote_id, version),
  FOREIGN KEY (organisation_id, quote_id) REFERENCES nzi_console.quotes(organisation_id, quote_id)
);
CREATE TABLE nzi_console.invoices (
  organisation_id text NOT NULL,
  invoice_id text NOT NULL,
  invoice_number text NOT NULL,
  client_id text NOT NULL,
  quote_id text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','overdue','paid')),
  currency char(3) NOT NULL,
  subtotal numeric(14,2) NOT NULL CHECK (subtotal >= 0),
  balance numeric(14,2) NOT NULL CHECK (balance >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, invoice_id),
  UNIQUE (organisation_id, invoice_number),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id),
  FOREIGN KEY (organisation_id, quote_id) REFERENCES nzi_console.quotes(organisation_id, quote_id)
);
CREATE TABLE nzi_console.invoice_line_items (
  organisation_id text NOT NULL,
  line_item_id text NOT NULL,
  invoice_id text NOT NULL,
  description text NOT NULL,
  quantity numeric(14,4) NOT NULL CHECK (quantity > 0),
  unit_price numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (organisation_id, line_item_id),
  FOREIGN KEY (organisation_id, invoice_id) REFERENCES nzi_console.invoices(organisation_id, invoice_id)
);
CREATE TABLE nzi_console.credit_notes (
  organisation_id text NOT NULL,
  credit_note_id text NOT NULL,
  credit_note_number text NOT NULL,
  client_id text NOT NULL,
  invoice_id text,
  job_id text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','applied')),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, credit_note_id),
  UNIQUE (organisation_id, credit_note_number),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id),
  FOREIGN KEY (organisation_id, invoice_id) REFERENCES nzi_console.invoices(organisation_id, invoice_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id)
);
CREATE TABLE nzi_console.commercial_xero_links (
  organisation_id text NOT NULL,
  document_type text NOT NULL CHECK (document_type IN ('quote','invoice','credit_note')),
  document_id text NOT NULL,
  external_ref text,
  sync_status text NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending','synced','failed','not_configured')),
  last_synced_at timestamptz,
  PRIMARY KEY (organisation_id, document_type, document_id)
);
CREATE TABLE nzi_console.commercial_document_events (
  organisation_id text NOT NULL,
  event_id text NOT NULL,
  document_type text NOT NULL CHECK (document_type IN ('quote','invoice','credit_note')),
  document_id text NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id text NOT NULL,
  detail_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (organisation_id, event_id)
);
REVOKE UPDATE, DELETE ON nzi_console.commercial_document_events FROM nzi_console_app;
ALTER TABLE nzi_console.quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.quote_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.invoice_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.commercial_xero_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.commercial_document_events ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE table_name text; BEGIN FOR table_name IN SELECT unnest(ARRAY['quotes','quote_versions','invoices','invoice_line_items','credit_notes','commercial_xero_links','commercial_document_events']) LOOP EXECUTE format('ALTER TABLE nzi_console.%I FORCE ROW LEVEL SECURITY', table_name); EXECUTE format('CREATE POLICY tenant_isolation ON nzi_console.%I USING (organisation_id = current_setting(''app.organisation_id'', true)) WITH CHECK (organisation_id = current_setting(''app.organisation_id'', true))', table_name); END LOOP; END $$;
GRANT SELECT, INSERT, UPDATE ON nzi_console.commercial_xero_links TO nzi_console_worker;
