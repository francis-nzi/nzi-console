-- 0211 Priority on an SRS assessment item (RULING-srs-assessment-priority-vocabulary.md; NZC-022).
--
-- ## Why
--
-- The guided assessment records, per requirement, a score, evidence, an owner and a target date. How urgent the gap is
-- was the missing triage field. `owner` and `due_date` already sit on the item independent of a funded action; `priority`
-- joins them.
--
-- ## What this adds
--
-- `srs_assessment_items.priority`: nullable, exactly 'high' | 'medium' | 'low'. NULL is "unset" - an `auto` (pre-filled)
-- answer carries none until a consultant sets one. The same three values are `Priority` in @nzi/contracts; the actions
-- module will import that type and this vocabulary when it gains a priority, so the term means one thing everywhere.
--
-- It is urgency, not certainty. The values coincide with the estimate-confidence scale of 0085 but the concepts differ,
-- and this column shares nothing with that one.
--
-- ## What it does not change
--
-- No maturity, status, score, framework or action link. There is deliberately no per-item status: the item's state is
-- its maturity against target, and work-tracking status lives on the linked action. Existing rows read NULL.
ALTER TABLE nzi_console.srs_assessment_items
  ADD COLUMN priority text,
  ADD CONSTRAINT srs_assessment_items_priority_check CHECK (priority IS NULL OR priority IN ('high', 'medium', 'low'));

COMMENT ON COLUMN nzi_console.srs_assessment_items.priority IS 'Triage urgency of closing this gap: high, medium or low; NULL = unset. A consultant working record - never crosses to the client portal or a client document.';
