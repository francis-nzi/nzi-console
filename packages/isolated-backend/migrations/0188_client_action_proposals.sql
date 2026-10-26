-- 0188 Actions A2: a client's proposal, decided by staff, and an approved one promoted into the library
-- (BUILD-actions-A2-portal-engagement, R2, R3, R7; DESIGN-actions-srs-workflows).
--
-- ## Extends A1, does not fork
--
-- A1 (0186) reserved `origin = 'client_proposal'` on `client_strategies` and refused it in the consultant's command. A2
-- is where a client creates one, in the portal. A proposal is a row of the same table — the same spine S3 writes gap
-- actions into — with one thing A1's ladder cannot say: whether staff have **decided** it yet.
--
-- ## 1. The decision (R2)
--
-- `proposal_state`: `pending` (the client proposed it; staff have not ruled), `approved` (it became a real plan action),
-- or `declined` (not taken forward, with the reason the client is shown). It is set exactly when `origin` is
-- `client_proposal` and null on every other row. A pending proposal is `proposed` on the ladder and stays there until
-- decided; a declined one is `declined` and stays there — a client's declined proposal is not reopened on the ladder,
-- it is proposed again as a new one. Approval moves it to `agreed` (A1's Proposed → Agreed, made by staff).
--
-- The decision is made once: a trigger refuses any change to a decided proposal's state, so "approved" or "declined"
-- in the record is what happened, not what someone later set it to.
--
-- `proposal_note` is what the client wrote about it — theirs, shown back to them, unlike `notes`, which is the
-- consultant's working note and never crosses to the portal.
--
-- ## 2. The alignment rule waits for the decision (R7)
--
-- 0081 requires every active strategy on a plan to advance at least one UK SRS requirement, at COMMIT. A client
-- proposing an action is not asked which disclosure requirement it advances — that is the consultant's judgement, made
-- when they approve it. So a pending proposal, and a declined one, are not yet (or never) on the plan, and are exempt;
-- the approval command aligns it in the same transaction that agrees it, and from then on the rule holds as before.
--
-- ## 3. Promoted into the library (R3)
--
-- `reduction_strategies.promoted_from_client_strategy_id` records the approved proposal a library strategy was made
-- from — once each (a unique index), and only ever by staff holding the library capability. The client's own action
-- stays theirs and stays bespoke: the library entry is a copy for every other client, not a rewrite of this one.

BEGIN;

-- ── 1. The decision ─────────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE nzi_console.client_strategies
  ADD COLUMN proposal_state text CHECK (proposal_state IN ('pending', 'approved', 'declined')),
  ADD COLUMN proposal_note text NOT NULL DEFAULT '' CHECK (char_length(proposal_note) <= 2000),
  ADD COLUMN proposal_decision_reason text CHECK (proposal_decision_reason IS NULL OR char_length(proposal_decision_reason) <= 2000),
  ADD COLUMN proposal_decided_at timestamptz,
  ADD COLUMN proposal_decided_by text,
  -- Exactly the client's proposals carry a decision state.
  ADD CONSTRAINT client_strategies_proposal_shape CHECK (
    (origin = 'client_proposal') = (proposal_state IS NOT NULL)
    -- A decided proposal says when and by whom; an undecided one does not.
    AND (coalesce(proposal_state, '') IN ('approved', 'declined')) = (proposal_decided_at IS NOT NULL AND proposal_decided_by IS NOT NULL)
    -- Only a declined one carries the reason the client is shown.
    AND (coalesce(proposal_state, '') = 'declined') = (nullif(trim(proposal_decision_reason), '') IS NOT NULL)),
  -- Pending sits at the foot of the ladder, declined at its edge; neither moves until (or after) it is decided.
  ADD CONSTRAINT client_strategies_proposal_ladder CHECK (
    (coalesce(proposal_state, '') <> 'pending' OR status = 'proposed')
    AND (coalesce(proposal_state, '') <> 'declined' OR status = 'declined'));

CREATE INDEX client_strategies_pending_proposals_idx ON nzi_console.client_strategies (organisation_id, client_id)
  WHERE proposal_state = 'pending';

COMMENT ON COLUMN nzi_console.client_strategies.proposal_state IS
  'A2: for a client''s proposal (origin client_proposal) only — pending until staff decide, then approved (a real plan action, agreed) or declined (with the reason the client sees). Decided once.';
COMMENT ON COLUMN nzi_console.client_strategies.proposal_note IS
  'A2: what the client wrote about their proposal — shown back to them. Not the consultant''s notes, which never reach the portal.';
COMMENT ON COLUMN nzi_console.client_strategies.proposal_decision_reason IS
  'A2: why a client''s proposal was not taken forward, as the client is shown it. Present exactly when declined.';

CREATE FUNCTION nzi_console.client_strategies_proposal_decided_once() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, nzi_console AS $$
BEGIN
  IF OLD.proposal_state IN ('approved', 'declined')
     AND (NEW.proposal_state IS DISTINCT FROM OLD.proposal_state
          OR NEW.proposal_decision_reason IS DISTINCT FROM OLD.proposal_decision_reason
          OR NEW.proposal_decided_at IS DISTINCT FROM OLD.proposal_decided_at
          OR NEW.proposal_decided_by IS DISTINCT FROM OLD.proposal_decided_by) THEN
    RAISE EXCEPTION 'A client''s proposal is decided once; this one was already %.', OLD.proposal_state
      USING ERRCODE = 'check_violation', CONSTRAINT = 'client_strategies_proposal_decided_once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER client_strategies_proposal_decided_once BEFORE UPDATE ON nzi_console.client_strategies
  FOR EACH ROW EXECUTE FUNCTION nzi_console.client_strategies_proposal_decided_once();

-- ── 2. The alignment rule waits for the decision ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION nzi_console.client_strategy_requires_alignment()
RETURNS trigger LANGUAGE plpgsql AS $alignment$
DECLARE
  aligned integer;
  still_active boolean;
  decision text;
BEGIN
  SELECT active, proposal_state INTO still_active, decision FROM nzi_console.client_strategies
  WHERE organisation_id = NEW.organisation_id AND client_strategy_id = NEW.client_strategy_id;
  -- Gone entirely (deleted in the same transaction) or no longer on the plan: nothing to say.
  IF still_active IS NOT TRUE THEN RETURN NULL; END IF;
  -- A2: a client's proposal not yet decided, or declined, is not on the plan; staff align it when they approve it.
  IF decision IN ('pending', 'declined') THEN RETURN NULL; END IF;

  SELECT count(*) INTO aligned FROM nzi_console.client_strategy_srs_requirements
  WHERE organisation_id = NEW.organisation_id AND client_strategy_id = NEW.client_strategy_id;

  IF aligned = 0 THEN
    RAISE EXCEPTION 'Reduction strategy % has no SRS requirement aligned; every strategy on a plan must advance at least one.', NEW.client_strategy_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$alignment$;

-- ── 3. Promoted into the library ────────────────────────────────────────────────────────────────────────────

ALTER TABLE nzi_console.reduction_strategies
  ADD COLUMN promoted_from_client_strategy_id text,
  ADD CONSTRAINT reduction_strategies_promoted_from_fk
    FOREIGN KEY (organisation_id, promoted_from_client_strategy_id)
    REFERENCES nzi_console.client_strategies (organisation_id, client_strategy_id);
CREATE UNIQUE INDEX reduction_strategies_promoted_once ON nzi_console.reduction_strategies (organisation_id, promoted_from_client_strategy_id)
  WHERE promoted_from_client_strategy_id IS NOT NULL;

COMMENT ON COLUMN nzi_console.reduction_strategies.promoted_from_client_strategy_id IS
  'A2, R3: the approved client proposal this library strategy was promoted from, once each. Staff-only (the library capability); the client''s own action stays bespoke.';

COMMIT;
