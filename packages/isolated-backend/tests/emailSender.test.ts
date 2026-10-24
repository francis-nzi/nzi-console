import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  emailDispatchFromEnv, EmailTransportError, EmailValidationError, ISOLATED_RECIPIENT_DOMAINS, resendTransport, sendEmail,
  stubReasonFor, validateEmailRequest,
} from "../src/email";
import type { Queryable } from "../src/postgres";

/**
 * The email pipe's rules that need no database (phase 1): what a send must carry, what Resend is told, how a refusal is
 * judged, and who the gate lets mail reach. The queue and the drain are proved against Postgres in `emailOutboxReal`.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const KEY = "re_test_0123456789abcdef";

type Call = { url: string; init: RequestInit };
function fakeFetch(status: number, body: unknown, calls: Call[] = []): typeof fetch & { calls: Call[] } {
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch & { calls: Call[] };
  impl.calls = calls;
  return impl;
}

const message = { from: "NZI <no-reply@netzero.international>", to: "francis@netzero.international", subject: "Hello", html: "<p>Hi</p>", text: "Hi", replyTo: null, idempotencyKey: "m-1" };

describe("email: validation before anything is written", () => {
  it("refuses a missing recipient, subject or body, and never touches the database", async () => {
    const touched: string[] = [];
    const db: Queryable = { async query(text: string) { touched.push(text); return { rows: [] }; } };
    for (const bad of [
      { to: "", subject: "s", text: "b" },
      { to: "not-an-address", subject: "s", text: "b" },
      { to: "a@b.co", subject: "  ", text: "b" },
      { to: "a@b.co", subject: "s" },
      { to: "a@b.co", subject: "s", html: " ", text: "" },
    ]) {
      await assert.rejects(sendEmail(db, "org", bad), EmailValidationError, JSON.stringify(bad));
    }
    assert.deepEqual(touched, [], "a refused send writes nothing");
  });

  it("refuses line breaks in header fields, which is header injection", () => {
    assert.throws(() => validateEmailRequest({ to: "a@b.co", subject: "Hi\r\nBcc: x@y.z", text: "b" }), EmailValidationError);
    assert.throws(() => validateEmailRequest({ to: "a@b.co", subject: "s", text: "b", replyTo: "x@y.z\nBcc: q@r.s" }), EmailValidationError);
    assert.throws(() => validateEmailRequest({ to: "a@b.co", subject: "s", text: "b", from: "Name <not an address>" }), EmailValidationError);
  });

  it("normalises the recipient and accepts a named sender", () => {
    const valid = validateEmailRequest({ to: "  Francis@NetZero.International ", subject: " Hi ", text: "b", from: "Net Zero International <no-reply@netzero.international>" });
    assert.equal(valid.to, "francis@netzero.international");
    assert.equal(valid.subject, "Hi");
    assert.equal(valid.from, "Net Zero International <no-reply@netzero.international>");
    assert.equal(valid.html, null);
    assert.equal(valid.templateCode, null);
  });
});

describe("email: the Resend transport", () => {
  it("posts to the emails endpoint with the bearer key and the message id as the idempotency key", async () => {
    const fetchImpl = fakeFetch(200, { id: "re-abc" });
    const accepted = await resendTransport({ apiKey: KEY, fetchImpl }).send(message);
    assert.deepEqual(accepted, { id: "re-abc" });
    const [call] = fetchImpl.calls;
    assert.equal(call!.url, "https://api.resend.com/emails");
    const headers = call!.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${KEY}`);
    assert.equal(headers["Idempotency-Key"], "m-1");
    assert.deepEqual(JSON.parse(call!.init.body as string), {
      from: message.from, to: ["francis@netzero.international"], subject: "Hello", html: "<p>Hi</p>", text: "Hi",
    });
  });

  it("judges a bad request final and a rate limit, outage or in-flight key retryable — and never echoes the key", async () => {
    for (const [status, retryable] of [[422, false], [403, false], [409, true], [429, true], [500, true], [503, true]] as const) {
      const error = await resendTransport({ apiKey: KEY, fetchImpl: fakeFetch(status, { message: "nope" }) }).send(message)
        .then(() => null, (caught: unknown) => caught);
      assert.ok(error instanceof EmailTransportError, String(status));
      assert.equal(error.retryable, retryable, String(status));
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.ok(!error.message.includes(KEY), "the key never appears in an error");
    }
    const unreachable = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await assert.rejects(resendTransport({ apiKey: KEY, fetchImpl: unreachable }).send(message),
      (error: unknown) => error instanceof EmailTransportError && error.retryable);
  });

  it("treats an acceptance with no message id as a final failure rather than a send it cannot evidence", async () => {
    await assert.rejects(resendTransport({ apiKey: KEY, fetchImpl: fakeFetch(200, {}) }).send(message),
      (error: unknown) => error instanceof EmailTransportError && !error.retryable);
  });
});

describe("email: the gate", () => {
  const isolated = { NZI_DATABASE_BOUNDARY: "isolated-non-production", NEXT_PUBLIC_APP_ENV: "staging" };

  it("stubs with no key, and with a key but no sender", () => {
    assert.deepEqual(emailDispatchFromEnv({ ...isolated }).gate, { mode: "stub", reason: "RESEND_API_KEY is not set." });
    assert.deepEqual(emailDispatchFromEnv({ ...isolated, RESEND_API_KEY: KEY }).gate, { mode: "stub", reason: "EMAIL_FROM is not set." });
    assert.equal(emailDispatchFromEnv({ ...isolated, RESEND_API_KEY: KEY, EMAIL_FROM: "nobody" }).gate.mode, "stub");
    assert.equal(emailDispatchFromEnv({}).transport, null);
  });

  it("narrows rather than opens on the isolated boundary: only the NZI domain is sent to", () => {
    const dispatch = emailDispatchFromEnv({ ...isolated, RESEND_API_KEY: KEY, EMAIL_FROM: "NZI <no-reply@netzero.international>", NZI_MAIL_MODE: "send" });
    assert.deepEqual(dispatch.gate, { mode: "isolated", domains: ["netzero.international"] });
    assert.ok(dispatch.transport);
    assert.equal(stubReasonFor(dispatch.gate, "francis@netzero.international"), null);
    assert.match(stubReasonFor(dispatch.gate, "someone@client.example")!, /sends only to @netzero\.international/);
    // A look-alike is not the domain.
    assert.notEqual(stubReasonFor(dispatch.gate, "x@evil-netzero.international"), null);
    assert.notEqual(stubReasonFor(dispatch.gate, "x@netzero.international.example"), null);
    assert.deepEqual(ISOLATED_RECIPIENT_DOMAINS, ["netzero.international"]);
  });

  it("off the isolated boundary, a key alone is not enough: the existing mail gate still decides", () => {
    const keyed = { RESEND_API_KEY: KEY, EMAIL_FROM: "no-reply@netzero.international" };
    assert.equal(emailDispatchFromEnv({ ...keyed, NEXT_PUBLIC_APP_ENV: "staging" }).gate.mode, "stub");
    assert.equal(emailDispatchFromEnv({ ...keyed, NEXT_PUBLIC_APP_ENV: "production" }).gate.mode, "stub");
    assert.deepEqual(emailDispatchFromEnv({ ...keyed, NEXT_PUBLIC_APP_ENV: "production", NZI_MAIL_MODE: "send" }).gate, { mode: "live" });
    assert.equal(stubReasonFor({ mode: "live" }, "anyone@client.example"), null);
  });
});

describe("email: deployment", () => {
  const render = readFileSync(join(ROOT, "render.yaml"), "utf8");
  const source = readFileSync(join(ROOT, "packages", "isolated-backend", "src", "email.ts"), "utf8");

  it("declares the key and the sender on the worker, valued in the dashboard and never here", () => {
    const worker = render.slice(render.indexOf("name: nzi-console-reminders"));
    for (const key of ["RESEND_API_KEY", "EMAIL_FROM"]) {
      assert.match(worker, new RegExp(`- key: ${key}\\s+sync: false`), key);
    }
    assert.doesNotMatch(render, /re_[A-Za-z0-9]{16,}/, "no Resend key is committed");
    assert.doesNotMatch(render, /^\s+- key: NZI_MAIL_MODE/m, "the reminder send switch stays absent");
  });

  it("keeps the isolated allowlist a code constant, not something the environment can widen", () => {
    assert.match(source, /export const ISOLATED_RECIPIENT_DOMAINS: readonly string\[\] = \["netzero\.international"\];/);
    assert.doesNotMatch(source, /env\.[A-Z_]*DOMAIN/);
  });
});
