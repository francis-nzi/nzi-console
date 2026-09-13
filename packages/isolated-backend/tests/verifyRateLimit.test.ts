import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  claimVerifyAttempt, claimVerifyMiss, clientAddressFrom, verifyBucketKey,
  VERIFY_MISS_LIMIT, VERIFY_OVERALL_LIMIT,
} from "../src/verifyRateLimit";

const migration = readFileSync(new URL("../migrations/0074_verify_rate_limit.sql", import.meta.url), "utf8");

/** A stand-in for the claim function: counts per bucket, answers like the real one. */
function fakeDb(limitBehaviour?: (bucket: string) => boolean) {
  const calls: Array<{ bucket: string; limit: number }> = [];
  const used = new Map<string, number>();
  return {
    calls,
    db: {
      async query(_sql: string, values?: readonly unknown[]) {
        const bucket = String(values![0]), limit = Number(values![1]);
        calls.push({ bucket, limit });
        const count = (used.get(bucket) ?? 0) + 1;
        used.set(bucket, count);
        return { rows: [{ allowed: limitBehaviour ? limitBehaviour(bucket) : count <= limit }] };
      },
    } as never,
  };
}

describe("public verification rate limit", () => {
  describe("deriving the caller's address", () => {
    it("takes the address the trusted proxy observed, not the one the client claimed", () => {
      // A proxy APPENDS what it saw, so a client that sends its own header keeps it at the
      // front with the real address after it. Reading the leftmost entry — the intuitive
      // "original client" — is exactly how a caller defeats a limiter by varying a header.
      assert.equal(clientAddressFrom("203.0.113.9, 198.51.100.4"), "198.51.100.4");
      assert.equal(clientAddressFrom("1.1.1.1"), "1.1.1.1");
    });

    it("gives a spoofing caller the same bucket however they vary the header", () => {
      const salt = "s";
      const forged = ["10.0.0.1", "10.0.0.2", "10.0.0.3"]
        .map((claimed) => verifyBucketKey(clientAddressFrom(`${claimed}, 198.51.100.4`), "miss", salt));
      assert.equal(new Set(forged).size, 1, "varying X-Forwarded-For must not mint new buckets");
    });

    it("counts back past our own proxies when more than one sits in front", () => {
      // With two trusted hops the real client is second from the right: the rightmost entry
      // is our own inner proxy, and keying on it would collapse every caller into one bucket.
      assert.equal(clientAddressFrom("203.0.113.9, 198.51.100.4, 10.0.0.7", 2), "198.51.100.4");
    });

    it("puts callers with no usable header into one shared bucket rather than letting them past", () => {
      assert.equal(clientAddressFrom(null), "unknown");
      assert.equal(clientAddressFrom(""), "unknown");
      assert.equal(clientAddressFrom("   ,  "), "unknown");
    });
  });

  describe("the buckets", () => {
    it("keys on a salted hash, never on the address itself", () => {
      const key = verifyBucketKey("198.51.100.4", "all", "pepper");
      assert.ok(!key.includes("198.51.100.4"), "an address must not be stored to make a counter work");
      // IPv4 is small enough that an unsalted hash is reversible by anyone reading the table.
      assert.notEqual(key, verifyBucketKey("198.51.100.4", "all", "different-pepper"));
      assert.equal(key, verifyBucketKey("198.51.100.4", "all", "pepper"), "and it is stable");
    });

    it("separates the miss budget from the overall one", async () => {
      const { db, calls } = fakeDb();
      await claimVerifyAttempt(db, "198.51.100.4", "s");
      await claimVerifyMiss(db, "198.51.100.4", "s");
      assert.notEqual(calls[0]!.bucket, calls[1]!.bucket, "a sweep and a busy verifier are not the same caller");
      assert.equal(calls[0]!.limit, VERIFY_OVERALL_LIMIT);
      assert.equal(calls[1]!.limit, VERIFY_MISS_LIMIT);
      assert.ok(VERIFY_MISS_LIMIT < VERIFY_OVERALL_LIMIT, "the enumeration budget is the tight one");
    });

    it("lets a real verifier through while stopping a sweep at the miss budget", async () => {
      const { db } = fakeDb();
      // Someone checking a shortlist: every code is real, so no miss is ever claimed.
      for (let index = 0; index < 25; index += 1) {
        assert.equal(await claimVerifyAttempt(db, "198.51.100.4", "s"), true, `hit ${index + 1} should pass`);
      }
      // A sweep from another address: misses run out long before the overall budget does.
      const sweep = [];
      for (let index = 0; index < VERIFY_MISS_LIMIT + 2; index += 1) {
        sweep.push(await claimVerifyMiss(db, "203.0.113.9", "s"));
      }
      assert.deepEqual(sweep.slice(0, VERIFY_MISS_LIMIT), Array(VERIFY_MISS_LIMIT).fill(true));
      assert.deepEqual(sweep.slice(VERIFY_MISS_LIMIT), [false, false]);
    });

    it("refuses when the check itself cannot be completed", async () => {
      // A limiter that fails open is decoration: breaking this query would be how you turn
      // it off.
      const broken = { async query() { return { rows: [] }; } } as never;
      assert.equal(await claimVerifyAttempt(broken, "198.51.100.4", "s"), false);
      assert.equal(await claimVerifyMiss(broken, "198.51.100.4", "s"), false);
    });
  });

  describe("the migration", () => {
    it("claims a slot in one statement, so concurrent requests cannot share it", () => {
      // Read-then-write would let two requests both see "9 used" and both take the tenth
      // slot — a limiter that stops limiting under exactly the load it exists for.
      assert.match(migration, /INSERT INTO nzi_console\.verify_rate_limit[\s\S]*?ON CONFLICT \(bucket_key\) DO UPDATE[\s\S]*?RETURNING existing\.attempts INTO used/);
      assert.doesNotMatch(migration, /SELECT attempts[\s\S]{0,200}UPDATE nzi_console\.verify_rate_limit/, "no read-then-write");
      assert.match(migration, /RETURN used <= p_limit/);
    });

    it("restarts an expired window instead of accumulating forever", () => {
      assert.match(migration, /window_started_at < now\(\) - p_window THEN now\(\)/);
      assert.match(migration, /window_started_at < now\(\) - p_window THEN 1 +ELSE existing\.attempts \+ 1/);
    });

    it("keeps the table bounded against a caller rotating addresses", () => {
      // Otherwise a defence against one denial-of-service is unbounded growth in our own
      // database, which is another.
      assert.match(migration, /DELETE FROM nzi_console\.verify_rate_limit WHERE window_started_at < now\(\) - interval '1 day'/);
      assert.match(migration, /CREATE INDEX verify_rate_limit_window_idx/);
    });

    it("is reached only through the function, and is not tenant data", () => {
      assert.match(migration, /SECURITY DEFINER SET search_path = nzi_console, pg_temp/);
      assert.match(migration, /GRANT EXECUTE ON FUNCTION nzi_console\.claim_verify_attempt\(text, integer, interval\) TO nzi_console_app;/);
      assert.match(migration, /REVOKE ALL ON nzi_console\.verify_rate_limit FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;/);
      // An unauthenticated caller has no organisation, so there is nothing to scope by —
      // this table must not pretend otherwise by carrying a column it cannot populate.
      // Comments are stripped: the migration explains the absence, which is not the same
      // as declaring the column.
      const ddl = migration.replace(/^\s*--.*$/gm, "");
      assert.doesNotMatch(ddl, /organisation_id/);
      assert.doesNotMatch(ddl, /ROW LEVEL SECURITY/, "there is no tenant to isolate by");
    });
  });
});
