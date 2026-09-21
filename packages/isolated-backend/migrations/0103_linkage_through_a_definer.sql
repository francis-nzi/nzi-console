-- 0103 The linkage table gets no direct privilege at all, and two narrow doors instead (NZC-121).
--
-- ## What ran, and what it proved
--
-- The seal path (NZC-119) touched `data_subject_linkage` directly, twice. Both were wrong, and neither
-- was discoverable until the suite ran against a real Postgres for the first time — it was one of the
-- seventeen that CI never ran.
--
--   1. **The write.** `INSERT … ON CONFLICT (…) DO UPDATE` needs SELECT on the conflict-target columns,
--      and 0101 revoked SELECT. INSERT and UPDATE were granted, so the statement looked permitted and
--      was not: `permission denied for table data_subject_linkage`.
--
--   2. **The read, which is the real fault.** Resolving a subject at write time joined
--      `data_subject_linkage` to find the same address in another table. That is exactly the correlating
--      read NZC-118 confined, done by the role it was confined against. A privilege slip is a typo; this
--      was the design contradicting itself, and the grant caught it.
--
-- ## Zero direct privilege, both doors through a definer
--
-- So INSERT and UPDATE are revoked too and the table becomes reachable only through functions. Not a
-- wider grant: a grant that makes the failing statement legal would also make the correlating read
-- legal, which is the thing being prevented.
--
-- Narrow means narrow. `record_subject_linkage` writes **one row, the one named in its arguments**, and
-- returns nothing — so it cannot hand a digest back. `subjects_sharing_linkage` answers "which subject
-- already holds one of these digests, and was it in your own table" for **at most four digests at a
-- time**, which is what a row with two addresses needs and too few to enumerate with. Neither returns a
-- digest, so nothing here lets a caller take the correlatable value away.
--
-- The caller already holds the linkage key — it must, to compute the digests it writes — so being able
-- to ask about a digest it has itself computed is not a new capability. What the confinement withholds
-- is *reading stored digests*, which is how an estate gets correlated, and that stays withheld.
--
-- ## Integrity the table cannot express
--
-- `data_subject_linkage` has no foreign keys to the person-tables, by design: it is written by a role
-- that cannot read it, and it outlives nothing. So the write function checks the row it is asked about
-- actually exists, which is the only place that check can live.
--
-- ## What this does *not* do: the authentication context
--
-- A `SECURITY DEFINER` function does not bypass row-level security. `data_subject_linkage` has
-- `FORCE ROW LEVEL SECURITY` and a `tenant_isolation` policy on `app.organisation_id`, so an insert for
-- a real organisation made from the authentication context — where that setting is the pseudo-tenant
-- `'authentication'` — is refused by the policy whoever owns the function. Granting EXECUTE to
-- `nzi_console_auth` here would therefore buy nothing and suggest otherwise.
--
-- So this migration fixes the application path and is built to be reused, and the authentication
-- writers stay `awaiting-auth-bridge`. Their bridge has a policy question to answer, not a privilege
-- one, and it is a separate decision with its own review stop.

BEGIN;

-- ── No direct way in ─────────────────────────────────────────────────────────────────
REVOKE INSERT, UPDATE ON nzi_console.data_subject_linkage FROM nzi_console_app;

COMMENT ON TABLE nzi_console.data_subject_linkage IS
  'One digest per address, shared across the person-tables so the linker can compare them — and confined to it absolutely: no role holds any direct privilege, and every read and write goes through a SECURITY DEFINER function that returns no digest. Never joined into a read model.';

-- ── Door one: record the digest for one row ──────────────────────────────────────────
CREATE FUNCTION nzi_console.record_subject_linkage(
  p_organisation_id text,
  p_source_table text,
  p_source_id text,
  p_field text,
  p_linkage_bidx text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = nzi_console, pg_temp AS $$
BEGIN
  -- The caller may only write inside its own tenant context. Same shape as
  -- `revoke_trainee_sessions`: a definer function's first job is to refuse the thing its privilege
  -- would otherwise allow.
  IF p_organisation_id IS DISTINCT FROM current_setting('app.organisation_id', true) THEN
    RAISE EXCEPTION 'Cannot record linkage outside the current organisation' USING ERRCODE = '42501';
  END IF;

  -- The person has to exist. There are no foreign keys here to say so, and a linkage row for nobody is
  -- a row the linker would try to reconcile for ever. Written out per table rather than as dynamic SQL,
  -- because dynamic SQL inside a definer function is where injection lives.
  IF NOT (
    (p_source_table = 'trainees' AND EXISTS (
      SELECT 1 FROM nzi_console.trainees WHERE organisation_id = p_organisation_id AND trainee_id = p_source_id))
    OR (p_source_table = 'client_contacts' AND EXISTS (
      SELECT 1 FROM nzi_console.client_contacts WHERE organisation_id = p_organisation_id AND contact_id = p_source_id))
    OR (p_source_table = 'portal_users' AND EXISTS (
      SELECT 1 FROM nzi_console.portal_users WHERE organisation_id = p_organisation_id AND portal_user_id = p_source_id))
    OR (p_source_table = 'memberships' AND EXISTS (
      SELECT 1 FROM nzi_console.memberships WHERE organisation_id = p_organisation_id AND user_id = p_source_id))
    OR (p_source_table = 'trainee_email_changes' AND EXISTS (
      SELECT 1 FROM nzi_console.trainee_email_changes WHERE organisation_id = p_organisation_id AND change_id = p_source_id))
  ) THEN
    RAISE EXCEPTION 'No % row to record linkage for', p_source_table USING ERRCODE = '23503';
  END IF;

  INSERT INTO nzi_console.data_subject_linkage (organisation_id, source_table, source_id, field, linkage_bidx)
  VALUES (p_organisation_id, p_source_table, p_source_id, p_field, p_linkage_bidx)
  ON CONFLICT (organisation_id, source_table, source_id, field)
  DO UPDATE SET linkage_bidx = EXCLUDED.linkage_bidx, computed_at = now();
END $$;

REVOKE EXECUTE ON FUNCTION nzi_console.record_subject_linkage(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nzi_console.record_subject_linkage(text, text, text, text, text) TO nzi_console_app;

COMMENT ON FUNCTION nzi_console.record_subject_linkage(text, text, text, text, text) IS
  'Records the linkage digest for exactly the row named in its arguments, and returns nothing. The only way to write this table: the grant that would have made an upsert legal would also have made the correlating read legal.';

-- ── Door two: which subject already holds one of these digests ───────────────────────
--
-- What the write path needs to avoid minting a rival subject for somebody already known. It answers
-- about digests the caller supplied — which it computed itself, holding the linkage key — and never
-- about digests it has stored, so it discloses nothing the caller could not already compute. `same_table`
-- is the part the rule turns on: an address repeated inside one table is a shared mailbox, not a person.
CREATE FUNCTION nzi_console.subjects_sharing_linkage(
  p_organisation_id text,
  p_source_table text,
  p_digests text[]
) RETURNS TABLE (subject_id uuid, same_table boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = nzi_console, pg_temp AS $$
BEGIN
  IF p_organisation_id IS DISTINCT FROM current_setting('app.organisation_id', true) THEN
    RAISE EXCEPTION 'Cannot resolve linkage outside the current organisation' USING ERRCODE = '42501';
  END IF;

  -- A row has at most two addresses. A cap is what stops this being a bulk oracle: asking about four
  -- digests you already hold is a lookup, asking about forty thousand is an enumeration.
  IF p_digests IS NULL OR array_length(p_digests, 1) IS NULL OR array_length(p_digests, 1) > 4 THEN
    RAISE EXCEPTION 'Between one and four digests may be resolved at a time' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    SELECT DISTINCT l.subject_id, (k.source_table = p_source_table) AS same_table
      FROM nzi_console.data_subject_linkage k
      JOIN nzi_console.data_subject_links l
        ON (l.organisation_id, l.source_table, l.source_id) = (k.organisation_id, k.source_table, k.source_id)
     WHERE k.organisation_id = p_organisation_id
       AND k.linkage_bidx = ANY(p_digests);
END $$;

REVOKE EXECUTE ON FUNCTION nzi_console.subjects_sharing_linkage(text, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nzi_console.subjects_sharing_linkage(text, text, text[]) TO nzi_console_app;

COMMENT ON FUNCTION nzi_console.subjects_sharing_linkage(text, text, text[]) IS
  'Which subject already holds one of the supplied digests, and whether the match was in the caller''s own source table. Answers about digests the caller computed, never about digests it has stored, and returns no digest — so a write path can avoid minting a rival subject without being able to correlate the estate.';

COMMIT;
