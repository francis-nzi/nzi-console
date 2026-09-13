-- 0074 — Rate limiting the public certificate verification endpoint.
--
-- `verify_training_certificate` (0072) contains WHAT a stranger can read: its RETURNS TABLE
-- is the whole contract. What it does not contain is HOW OFTEN they can ask.
--
-- The verify code is `NZI-` plus 10 hex characters — a 40-bit space. Each individual hit
-- only ever returns the frozen contract, so no single request discloses anything it
-- shouldn't; the exposure is in the aggregate. With ~10^4 certificates in a ~10^12 space, a
-- caller sweeping at a thousand requests a second finds a real one in roughly a day. That
-- discovers the *set of valid codes*, which is exactly what the code is supposed to be
-- evidence of possessing. A limit is what makes holding the certificate mean something.
--
-- Two design notes worth stating, because both are easy to get wrong later:
--
--   * This table is NOT tenant data. An unauthenticated caller has no organisation, so
--     there is no `organisation_id` to scope it by and no RLS policy to write. It is
--     reached only through a SECURITY DEFINER function, the same containment shape as the
--     verification read itself.
--
--   * The bucket key is a SALTED HASH OF THE IP, never the address. Someone checking a
--     certificate before a job interview should not leave their IP in our database to make
--     a counter work. The hash is computed by the application, so this table never sees one.

BEGIN;

CREATE TABLE nzi_console.verify_rate_limit (
  bucket_key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);
-- Pruning reads by age, so the index is on the window rather than the key.
CREATE INDEX verify_rate_limit_window_idx ON nzi_console.verify_rate_limit (window_started_at);

COMMENT ON TABLE nzi_console.verify_rate_limit IS
  'Per-caller counters for the public certificate verification endpoint. Not tenant data: the caller is unauthenticated and has no organisation. Keys are salted hashes of the client IP, never the address itself.';

-- Claim one attempt against a bucket, atomically.
--
-- The whole check is a single INSERT .. ON CONFLICT .. RETURNING, so two requests arriving
-- together cannot both read "9 attempts" and both decide they are the tenth. A read-then-
-- write version of this function would be a rate limiter that does not limit under exactly
-- the load it exists to handle.
--
-- Returns true when the attempt is within budget. The row is incremented either way, so a
-- caller who keeps hammering after being refused stays refused until the window rolls.
CREATE FUNCTION nzi_console.claim_verify_attempt(p_bucket_key text, p_limit integer, p_window interval)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = nzi_console, pg_temp AS $$
DECLARE
  used integer;
BEGIN
  INSERT INTO nzi_console.verify_rate_limit AS existing (bucket_key, window_started_at, attempts)
  VALUES (p_bucket_key, now(), 1)
  ON CONFLICT (bucket_key) DO UPDATE SET
    -- An expired window restarts rather than accumulating, so a caller is not punished
    -- today for what they did last week.
    window_started_at = CASE WHEN existing.window_started_at < now() - p_window THEN now() ELSE existing.window_started_at END,
    attempts          = CASE WHEN existing.window_started_at < now() - p_window THEN 1    ELSE existing.attempts + 1 END
  RETURNING existing.attempts INTO used;

  -- Opportunistic pruning. Without it, a caller rotating addresses turns a defence against
  -- one denial-of-service into unbounded growth in our own database — which is another.
  -- Doing it here on a small fraction of calls keeps the table bounded with no scheduler.
  IF random() < 0.01 THEN
    DELETE FROM nzi_console.verify_rate_limit WHERE window_started_at < now() - interval '1 day';
  END IF;

  RETURN used <= p_limit;
END $$;

GRANT EXECUTE ON FUNCTION nzi_console.claim_verify_attempt(text, integer, interval) TO nzi_console_app;
REVOKE ALL ON nzi_console.verify_rate_limit FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

COMMENT ON FUNCTION nzi_console.claim_verify_attempt(text, integer, interval) IS
  'Atomically claims one attempt against a bucket and says whether it was within budget. Single-statement upsert so concurrent requests cannot both pass the same slot. Prunes expired rows opportunistically so a rotating caller cannot grow the table without bound.';

COMMIT;
