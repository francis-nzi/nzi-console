-- 0076 — `sphere_of_influence` → `control_level`.
--
-- One term, one meaning. "Sphere(s) of Influence" is already in use for the SBTi
-- beyond-value-chain framework in `portalActions.ts` — A: Products and Services, B: Portfolio
-- of Climate System Investments, and so on. The action-lever library's grouping is a
-- different idea: how much of an operational reduction the client actually controls. Two
-- concepts wearing one name is exactly the failure the naming principle exists to prevent,
-- so this one becomes `control_level` and the SBTi framework keeps the original term.
--
-- The VALUES are unchanged: 'direct_control' / 'supply_chain' / 'influence' already say
-- what they mean. Only the column name was overloaded.
--
-- This is a forward rename rather than an edit to 0075, because 0075 has been opened in a
-- pull request and is therefore frozen. A migration that has been reviewed or applied
-- anywhere must not grow afterwards — a file whose content changes after it has been run
-- somewhere is how an environment silently drifts from the repository.

BEGIN;

ALTER TABLE nzi_console.action_levers RENAME COLUMN sphere_of_influence TO control_level;
ALTER TABLE nzi_console.client_actions RENAME COLUMN bespoke_sphere_of_influence TO bespoke_control_level;

-- Postgres rewrites index and CHECK definitions to follow a renamed column, but it leaves
-- the constraint's own NAME behind. An error citing `..._sphere_of_influence_check` after
-- this migration would send whoever reads it looking for a column that no longer exists.
ALTER TABLE nzi_console.action_levers
  RENAME CONSTRAINT action_levers_sphere_of_influence_check TO action_levers_control_level_check;
ALTER TABLE nzi_console.client_actions
  RENAME CONSTRAINT client_actions_bespoke_sphere_of_influence_check TO client_actions_bespoke_control_level_check;

COMMENT ON COLUMN nzi_console.action_levers.control_level IS
  'How much of the outcome the client controls: direct_control | supply_chain | influence. Deliberately NOT "sphere of influence" — that term is reserved for the SBTi beyond-value-chain framework, which is a different concept.';
COMMENT ON COLUMN nzi_console.client_actions.bespoke_control_level IS
  'Set only on a bespoke action, which has no catalogue lever to read its grouping from.';

COMMIT;
