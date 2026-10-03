import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLIENT_LOGO_MAX_BYTES, commandDefinitions } from "@nzi/contracts";
import { inspectClientLogo } from "../src/clientLogo";
import { checkLogoUrl, fetchLogoFromUrl, guardedLookup, httpsFetchOnce, isBlockedAddress, type FetchOnce, type FetchOnceResult } from "../src/clientLogoFetch";

/**
 * A client logo from a URL (CLIENT-02, ruled PR 4): the SSRF hardening — https only on the standard port, only public
 * addresses (checked inside the connection's own lookup, and again on every redirect, at most 3), 5 s, 256 KB while
 * reading, an image type the store holds — and the widened store (JPEG, WebP) checked by each file's own signature.
 */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x1a, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.from([0, 0, 0, 0])]);

async function* chunks(...parts: Buffer[]) { for (const part of parts) yield part; }
const answer = (over: Partial<FetchOnceResult>): FetchOnceResult => ({ status: 200, location: null, contentType: "image/png", contentLength: null, body: chunks(PNG), cancel: () => undefined, ...over });
/** A transport that answers each requested URL from a script, recording what was asked. */
const scripted = (script: Record<string, Partial<FetchOnceResult>>) => {
  const asked: string[] = [];
  const fetchOnce: FetchOnce = async (url) => { asked.push(url.toString()); const step = script[url.toString()]; if (!step) throw new Error(`unscripted ${url}`); return answer(step); };
  return { fetchOnce, asked };
};

describe("the widened logo store (0153): each type checked by its own signature", () => {
  it("accepts a JPEG and a WebP by their bytes, and refuses a file that is not what it says", () => {
    assert.deepEqual(inspectClientLogo("image/jpeg", JPEG.toString("base64")).issues, []);
    assert.deepEqual(inspectClientLogo("image/webp", WEBP.toString("base64")).issues, []);
    assert.deepEqual(inspectClientLogo("image/jpeg", PNG.toString("base64")).issues, ["The file is not a JPEG image."]);
    assert.deepEqual(inspectClientLogo("image/webp", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]).toString("base64")).issues, ["The file is not a WebP image."]);
    assert.deepEqual(inspectClientLogo("image/png", JPEG.toString("base64")).issues, ["The file is not a PNG image."]);
  });

  it("lets client.logo.set take all four types, while the organisation's logo stays PNG or SVG", () => {
    const context = { actorId: "ada", organisationId: "org-a", idempotencyKey: "k", correlationId: "c" } as never;
    const client = (contentType: string) => commandDefinitions["client.logo.set"].validate({ clientId: "c1", fileName: "x", contentType, dataBase64: "AAAA" } as never, context).filter((issue) => issue.field === "contentType");
    const organisation = (contentType: string) => commandDefinitions["organisation.logo.set"].validate({ fileName: "x", contentType, dataBase64: "AAAA" } as never, context).filter((issue) => issue.field === "contentType");
    for (const type of ["image/png", "image/svg+xml", "image/jpeg", "image/webp"]) assert.deepEqual(client(type), [], type);
    assert.equal(client("image/gif").length, 1);
    assert.deepEqual(organisation("image/png"), []);
    assert.equal(organisation("image/jpeg").length, 1, "0142's organisation logo store holds PNG and SVG only");
  });
});

describe("which addresses may be fetched", () => {
  it("refuses every non-public IPv4 and IPv6 address, including IPv4 reached through IPv6", () => {
    for (const blocked of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
      "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe", "::10.0.0.1", "2001:db8::1", "not-an-ip"]) {
      assert.equal(isBlockedAddress(blocked), true, blocked);
    }
    for (const open of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isBlockedAddress(open), false, open);
  });

  it("checks the address before anything is fetched: https, the standard port, no credentials, no internal host", () => {
    assert.equal(checkLogoUrl("https://cdn.example.com/logo.png").ok, true);
    for (const [url, code] of [["http://cdn.example.com/logo.png", "INVALID_URL"], ["ftp://cdn.example.com/x", "INVALID_URL"], ["https://user:pw@cdn.example.com/x", "INVALID_URL"],
      ["https://cdn.example.com:8443/x", "INVALID_URL"], ["not a url", "INVALID_URL"], ["https://127.0.0.1/x", "BLOCKED_ADDRESS"], ["https://[::1]/x", "BLOCKED_ADDRESS"],
      ["https://169.254.169.254/latest/meta-data", "BLOCKED_ADDRESS"], ["https://localhost/x", "BLOCKED_ADDRESS"], ["https://intranet.internal/x", "BLOCKED_ADDRESS"]] as const) {
      const result = checkLogoUrl(url);
      assert.equal(result.ok ? "ok" : result.code, code, url);
    }
  });

  it("wires the real https transport to that lookup: a name resolving to loopback is refused before any connection", async () => {
    await assert.rejects(httpsFetchOnce(new URL("https://localhost/logo.png"), AbortSignal.timeout(3_000)), (error: Error & { code?: string }) => error.code === "BLOCKED_ADDRESS");
  });

  it("refuses the connection inside its own lookup when any address the name resolves to is not public", async () => {
    const resolveTo = (...addresses: string[]) => guardedLookup((_host, _options, callback) => callback(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))));
    const run = (lookup: ReturnType<typeof guardedLookup>) => new Promise<{ error: (Error & { code?: string }) | null; address: unknown }>((resolve) => lookup("cdn.example.com", {}, (error, address) => resolve({ error, address })));
    assert.deepEqual(await run(resolveTo("93.184.216.34")), { error: null, address: "93.184.216.34" });
    assert.equal((await run(resolveTo("93.184.216.34", "10.0.0.5"))).error?.code, "BLOCKED_ADDRESS", "one private answer refuses the lot");
    assert.equal((await run(resolveTo("127.0.0.1"))).error?.code, "BLOCKED_ADDRESS");
  });
});

describe("fetching a logo", () => {
  it("fetches a PNG, naming the file from the path", async () => {
    const { fetchOnce } = scripted({ "https://cdn.example.com/brand/acme.png": { contentType: "image/png; charset=binary" } });
    const result = await fetchLogoFromUrl("https://cdn.example.com/brand/acme.png", { fetchOnce });
    assert.ok(result.ok);
    assert.equal(result.contentType, "image/png");
    assert.equal(result.fileName, "acme.png");
    assert.deepEqual(Buffer.from(result.dataBase64, "base64"), PNG);
  });

  it("follows up to 3 redirects, re-checking each one, and refuses a 4th", async () => {
    const hops = (count: number) => Object.fromEntries([...Array(count).keys()].map((index) => [`https://a.example.com/${index}`, { status: 302, location: `/${index + 1}` }]));
    const three = scripted({ ...hops(3), "https://a.example.com/3": { contentType: "image/png" } });
    assert.equal((await fetchLogoFromUrl("https://a.example.com/0", { fetchOnce: three.fetchOnce })).ok, true);
    assert.equal(three.asked.length, 4);
    const four = scripted({ ...hops(4), "https://a.example.com/4": { contentType: "image/png" } });
    const refused = await fetchLogoFromUrl("https://a.example.com/0", { fetchOnce: four.fetchOnce });
    assert.equal(refused.ok ? "ok" : refused.code, "TOO_MANY_REDIRECTS");
  });

  it("refuses a redirect to an internal address or to http, without following it", async () => {
    for (const [location, code] of [["https://169.254.169.254/latest/meta-data", "BLOCKED_ADDRESS"], ["http://cdn.example.com/x.png", "INVALID_URL"], ["https://[::ffff:127.0.0.1]/", "BLOCKED_ADDRESS"]] as const) {
      const { fetchOnce, asked } = scripted({ "https://cdn.example.com/x": { status: 301, location } });
      const result = await fetchLogoFromUrl("https://cdn.example.com/x", { fetchOnce });
      assert.equal(result.ok ? "ok" : result.code, code, location);
      assert.deepEqual(asked, ["https://cdn.example.com/x"], "the redirect target is never requested");
    }
  });

  it("refuses what is not an image the store holds, an error status, and anything over 256 KB — declared or read", async () => {
    const one = (step: Partial<FetchOnceResult>) => fetchLogoFromUrl("https://cdn.example.com/x", { fetchOnce: scripted({ "https://cdn.example.com/x": step }).fetchOnce });
    const code = (result: Awaited<ReturnType<typeof fetchLogoFromUrl>>) => result.ok ? "ok" : result.code;
    assert.equal(code(await one({ contentType: "text/html" })), "NOT_AN_IMAGE");
    assert.equal(code(await one({ contentType: "image/gif" })), "NOT_AN_IMAGE");
    assert.equal(code(await one({ contentType: null })), "NOT_AN_IMAGE");
    assert.equal(code(await one({ status: 404 })), "HTTP_STATUS");
    assert.equal(code(await one({ contentLength: CLIENT_LOGO_MAX_BYTES + 1 })), "TOO_LARGE");
    let cancelled = false;
    const big = Buffer.alloc(100 * 1024);
    assert.equal(code(await one({ body: chunks(big, big, big), cancel: () => { cancelled = true; } })), "TOO_LARGE", "an undeclared length is capped while reading");
    assert.ok(cancelled, "the read is abandoned at the cap");
    for (const type of ["image/jpeg", "image/webp", "image/svg+xml"]) assert.equal(code(await one({ contentType: type })), "ok", type);
  });

  it("gives up after the time allowed, redirects included", async () => {
    const slow: FetchOnce = (_url, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    // AbortSignal.timeout does not hold the event loop open (a real socket does), so this test holds it.
    const hold = setTimeout(() => undefined, 5_000);
    const result = await fetchLogoFromUrl("https://cdn.example.com/x", { fetchOnce: slow, timeoutMs: 50 });
    clearTimeout(hold);
    assert.equal(result.ok ? "ok" : result.code, "TIMEOUT");
  });
});
