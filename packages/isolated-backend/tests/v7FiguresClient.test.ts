import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { V7_FIGURES_CONTRACT } from "@nzi/contracts";
import { v7FiguresClientFromEnv, V7FiguresConnectionRefused } from "../src/v7Drift";

/**
 * The drift guard's read of the previous system's own figures (CONTRACT-v7-import-figures v1): the URL guard, what is sent, and every
 * answer that is not a v1 reply read as unknown — never zero, never level.
 */
const REPLY = {
  contract: V7_FIGURES_CONTRACT, job_id: 663, job_number: "J000663", computed_at: "2026-11-25T14:02:11Z", period: { from: "2025-04-01", to: "2026-03-31" },
  scope_totals: { scope_1: 93.83, scope_2: 2121.17, scope_3: 21839.06, total: 24054.11 }, counted_rows: 180, rows_updated_at: null,
};
const ENV = { NZI_V7_FIGURES_URL: "https://v7.example.test/", NZI_V7_FIGURES_TOKEN: "t0ken", NZI_ISOLATED_API_URL: "https://console.example.test" };
const JOB = { v7JobId: "663", legacyJobNumber: "J000663" };
const answering = (status: number, body: unknown, seen: Array<{ url: string; init: RequestInit | undefined }> = []): typeof fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => { seen.push({ url: String(url), init }); return new Response(typeof body === "string" ? body : JSON.stringify(body), { status }); }) as typeof fetch;

describe("the previous system's figures, read through the contract", () => {
  it("not configured: answers not-configured and calls nothing", async () => {
    let called = false;
    const client = v7FiguresClientFromEnv({}, (async () => { called = true; return new Response("{}"); }) as typeof fetch);
    assert.deepEqual(await client(JOB), { ok: false, reason: "not-configured" });
    assert.equal(called, false);
  });

  it("refuses a URL that is not HTTPS, or names the console itself", () => {
    assert.throws(() => v7FiguresClientFromEnv({ ...ENV, NZI_V7_FIGURES_URL: "http://v7.example.test" }), V7FiguresConnectionRefused);
    assert.throws(() => v7FiguresClientFromEnv({ ...ENV, NZI_V7_FIGURES_URL: "https://console.example.test/x" }), V7FiguresConnectionRefused);
    assert.throws(() => v7FiguresClientFromEnv({ ...ENV, NZI_V7_FIGURES_URL: "not a url" }), V7FiguresConnectionRefused);
  });

  it("asks for the one job's totals, with the token, refusing redirects; a v1 reply comes back as read", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const read = await v7FiguresClientFromEnv(ENV, answering(200, REPLY, seen))(JOB);
    assert.deepEqual(read, { ok: true, body: REPLY });
    assert.equal(seen[0]!.url, "https://v7.example.test/api/console-import/v1/jobs/663/scope-totals");
    assert.equal((seen[0]!.init!.headers as Record<string, string>).authorization, "Bearer t0ken");
    assert.equal(seen[0]!.init!.redirect, "error");
    assert.ok(seen[0]!.init!.signal, "bounded");
  });

  it("everything else is unknown, by a code: not found, can't compute, busy, refused, a bad body, another job, a dropped line, a timeout", async () => {
    const reason = async (fetchImpl: typeof fetch, job = JOB) => { const read = await v7FiguresClientFromEnv(ENV, fetchImpl)(job); return read.ok ? "ok" : read.reason; };
    assert.equal(await reason(answering(404, {})), "not-found");
    assert.equal(await reason(answering(422, { code: "MISSING_DATASET" })), "cannot-compute");
    assert.equal(await reason(answering(503, {})), "busy");
    assert.equal(await reason(answering(401, {})), "refused");
    assert.equal(await reason(answering(200, "not json")), "contract");
    assert.equal(await reason(answering(200, { ...REPLY, extra: 1 })), "contract");
    assert.equal(await reason(answering(200, REPLY), { v7JobId: "663", legacyJobNumber: "J000664" }), "contract", "a reply for another job");
    assert.equal(await reason((async () => { throw new TypeError("fetch failed"); }) as typeof fetch), "unreachable");
    assert.equal(await reason((async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }) as typeof fetch), "timeout");
    assert.equal(await reason(answering(200, REPLY), { v7JobId: "../admin", legacyJobNumber: "J000663" }), "not-found", "never a path but a number");
  });
});
