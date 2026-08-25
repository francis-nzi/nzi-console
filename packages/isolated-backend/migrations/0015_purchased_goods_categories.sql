BEGIN;
CREATE TABLE nzi_console.purchased_goods_categories (
 organisation_id text NOT NULL, category_id text NOT NULL, client_id text NOT NULL,
 name text NOT NULL CHECK(nullif(trim(name),'') IS NOT NULL), created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organisation_id,category_id), FOREIGN KEY(organisation_id,client_id) REFERENCES nzi_console.clients(organisation_id,client_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX purchased_goods_category_name_unique ON nzi_console.purchased_goods_categories(organisation_id,client_id,lower(trim(name)));
ALTER TABLE nzi_console.job_scope_rows ADD COLUMN purchased_goods_category_id text;
ALTER TABLE nzi_console.job_scope_rows ADD CONSTRAINT scope_row_purchased_goods_category_fk FOREIGN KEY(organisation_id,purchased_goods_category_id) REFERENCES nzi_console.purchased_goods_categories(organisation_id,category_id);
ALTER TABLE nzi_console.purchased_goods_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.purchased_goods_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.purchased_goods_categories USING(organisation_id=current_setting('app.organisation_id',true)) WITH CHECK(organisation_id=current_setting('app.organisation_id',true));
GRANT SELECT,INSERT,UPDATE ON nzi_console.purchased_goods_categories TO nzi_console_app;
COMMIT;
