-- 0183 The reminder worker may read everything its tick reads (BUILD-fix-worker-tick-permission, 26 Oct 2026).
--
-- ## Why
--
-- The `nzi-console-reminders` tick failed every 15 minutes with "permission denied for table strategy_levers", and because
-- the `email.send` drain ran later in the same transaction, no queued email was ever dispatched.
--
-- The cause is long-standing, not a recent regression: 0083 granted `nzi_console_worker` the tables the reminder scan read
-- then. On 14 Sep the plan read it shares with the console (`listClientStrategies`) began joining `strategy_levers` (#158)
-- and `client_strategy_srs_requirements` (#162), and the worker was never granted either. The reminder tests ran as the
-- superuser, so they could not see it; on staging the scan reaches that query only once a client has a dated plan.
--
-- ## What it does
--
-- - **Grants the two missing tables**, SELECT only — the worker reads a plan; it never edits one.
-- - **Asserts the whole tick's table set**, so a gap fails this migration loudly instead of every tick quietly. Every table
--   the tick touches, with the privileges it needs:
--     the scan        clients, client_strategies, reduction_strategies, strategy_levers, client_strategy_srs_requirements,
--                     client_contacts, message_templates (read); strategy_automation_log (read, claim, resolve);
--                     transactional_outbox (enqueue)
--     the drain       transactional_outbox (read, settle); strategy_automation_log; email_messages (read, resolve)
--   Granted before this: 0002 (outbox), 0083 (log and the plan's first four tables), 0149 (message_templates), 0178
--   (email_messages). Nothing is widened beyond what the tick does.

BEGIN;

GRANT SELECT ON nzi_console.strategy_levers TO nzi_console_worker;
GRANT SELECT ON nzi_console.client_strategy_srs_requirements TO nzi_console_worker;

DO $$
DECLARE
  needed record;
  missing text[] := '{}';
BEGIN
  FOR needed IN SELECT * FROM (VALUES
    ('clients', 'SELECT'), ('client_strategies', 'SELECT'), ('reduction_strategies', 'SELECT'),
    ('strategy_levers', 'SELECT'), ('client_strategy_srs_requirements', 'SELECT'), ('client_contacts', 'SELECT'),
    ('message_templates', 'SELECT'),
    ('strategy_automation_log', 'SELECT'), ('strategy_automation_log', 'INSERT'), ('strategy_automation_log', 'UPDATE'),
    ('transactional_outbox', 'SELECT'), ('transactional_outbox', 'INSERT'), ('transactional_outbox', 'UPDATE'),
    ('email_messages', 'SELECT'), ('email_messages', 'UPDATE')
  ) AS t(table_name, privilege) LOOP
    IF NOT has_table_privilege('nzi_console_worker', format('nzi_console.%I', needed.table_name), needed.privilege) THEN
      missing := missing || format('%s on %s', needed.privilege, needed.table_name);
    END IF;
  END LOOP;
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION '0183: nzi_console_worker still lacks what its tick needs: %', array_to_string(missing, ', ');
  END IF;
END $$;

COMMIT;
