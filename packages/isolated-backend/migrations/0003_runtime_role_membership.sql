BEGIN;

-- Supabase creates group-style runtime roles without automatically granting
-- their creator membership. The pooler principal needs membership so each
-- request can explicitly SET ROLE and become subject to the forced RLS rules.
GRANT nzi_console_app, nzi_console_worker TO CURRENT_USER;

COMMIT;
