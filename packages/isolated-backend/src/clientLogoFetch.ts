// A client logo from a URL (CLIENT-02): fetched once, server-side, at the moment it is linked, then validated and stored
// through client.logo.set like an upload. The URL itself is not kept and nothing is hot-linked, so reports and the portal
// never depend on the other host and nothing leaks to it afterwards.
//
// Fetching an address a person typed is a server-side-request-forgery surface, so (as ruled):
// - **https only**, on the standard port, with no credentials in the address;
// - **every address the host resolves to is checked** and the fetch refused if any is private, loopback, link-local,
//   shared, documentation, multicast or otherwise non-public — inside the connection's own DNS lookup, so the address
//   checked is the address connected to (no second lookup to rebind);
// - **redirects re-checked from the top**, at most 3;
// - **5 seconds** for the whole fetch, redirects included;
// - **256 KB**, enforced while reading (a larger declared length is refused before reading);
// - the response's **Content-Type** must be one the logo store holds (PNG, SVG, JPEG, WebP). The bytes are then checked
//   against that type's own signature by `inspectClientLogo` when the command stores them.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { CLIENT_LOGO_MAX_BYTES, clientLogoContentTypes, type ClientLogoContentType } from "@nzi/contracts";

export const LOGO_FETCH_TIMEOUT_MS = 5_000;
export const LOGO_FETCH_MAX_REDIRECTS = 3;

export type LogoFetchFailure = { ok: false; code: "INVALID_URL" | "BLOCKED_ADDRESS" | "UNREACHABLE" | "TOO_MANY_REDIRECTS" | "HTTP_STATUS" | "NOT_AN_IMAGE" | "TOO_LARGE" | "TIMEOUT"; message: string };
export type LogoFetchResult = { ok: true; contentType: ClientLogoContentType; dataBase64: string; fileName: string } | LogoFetchFailure;

const fail = (code: LogoFetchFailure["code"], message: string): LogoFetchFailure => ({ ok: false, code, message });

// ── Which addresses are public ──────────────────────────────────────────────────────────────────────────────────────

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["2001:db8::", 32], ["100::", 64],
  ["2001::", 32], ["2002::", 16],
] as const) BLOCKED.addSubnet(network, prefix, "ipv6");

/** The 8 hextets of an IPv6 address (any notation, including an embedded dotted IPv4 tail), or null. */
function hextets(address: string): number[] | null {
  let text = address.replace(/^\[|\]$/g, "").split("%")[0]!.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const parts = dotted[1]!.split(".").map(Number);
    if (parts.some((part) => part > 255)) return null;
    text = text.slice(0, -dotted[1]!.length) + `${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const [head, tail, extra] = text.split("::");
  if (extra !== undefined) return null;
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const all = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...right].map((group) => /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN);
  return all.length === 8 && all.every((value) => !Number.isNaN(value)) ? all : null;
}

/** Whether an address must never be fetched from: anything not on the public internet. */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family === 4) return BLOCKED.check(bare, "ipv4");
  if (family !== 6) return true;
  const groups = hextets(bare);
  if (!groups) return true;
  // An IPv4 address carried inside IPv6 (mapped ::ffff:a.b.c.d, compatible ::a.b.c.d, NAT64 64:ff9b::a.b.c.d) is judged
  // as the IPv4 address it reaches.
  const v4 = (high: number, low: number) => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  const zeros = (count: number) => groups.slice(0, count).every((group) => group === 0);
  if (zeros(5) && groups[5] === 0xffff) return BLOCKED.check(v4(groups[6]!, groups[7]!), "ipv4");
  if (zeros(6) && (groups[6] !== 0 || groups[7]! > 1)) return BLOCKED.check(v4(groups[6]!, groups[7]!), "ipv4");
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) return BLOCKED.check(v4(groups[6]!, groups[7]!), "ipv4");
  return BLOCKED.check(groups.map((group) => group.toString(16)).join(":"), "ipv6");
}

export type LookupFn = (hostname: string, options: { all: true }, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

/**
 * A DNS lookup for `https.request` that refuses the connection unless every address the name resolves to is public —
 * run by the connection itself, so the address checked is the address connected to.
 */
export function guardedLookup(resolve: LookupFn = dnsLookup as unknown as LookupFn) {
  return (hostname: string, options: object, callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    resolve(hostname, { all: true }, (error, addresses) => {
      if (error) return callback(error, "", 0);
      if (!addresses.length || addresses.some((entry) => isBlockedAddress(entry.address))) {
        return callback(Object.assign(new Error(`${hostname} does not resolve to a public address.`), { code: "BLOCKED_ADDRESS" }), "", 0);
      }
      if ((options as { all?: boolean }).all) return callback(null, addresses);
      return callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

/** The address, checked before anything is fetched: https, standard port, a host, no credentials, not a blocked literal. */
export function checkLogoUrl(raw: string): { ok: true; url: URL } | LogoFetchFailure {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return fail("INVALID_URL", "Enter the logo's full web address, starting https://."); }
  if (url.protocol !== "https:") return fail("INVALID_URL", "Only an https:// address can be fetched.");
  if (url.username || url.password) return fail("INVALID_URL", "The address must not carry a user name or password.");
  if (url.port !== "") return fail("INVALID_URL", "The address must use the standard https port.");
  if (!url.hostname) return fail("INVALID_URL", "Enter the logo's full web address, starting https://.");
  if (isIP(url.hostname.replace(/^\[|\]$/g, "")) && isBlockedAddress(url.hostname)) return fail("BLOCKED_ADDRESS", "That address is not on the public internet.");
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(url.hostname)) return fail("BLOCKED_ADDRESS", "That address is not on the public internet.");
  return { ok: true, url };
}

// ── The fetch ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type FetchOnceResult = { status: number; location: string | null; contentType: string | null; contentLength: number | null; body: AsyncIterable<Buffer>; cancel: () => void };
export type FetchOnce = (url: URL, signal: AbortSignal) => Promise<FetchOnceResult>;

/** One https GET with the guarded lookup, no connection reuse and no automatic redirects. */
export const httpsFetchOnce: FetchOnce = (url, signal) => new Promise((resolve, reject) => {
  const request = httpsRequest(url, {
    method: "GET", agent: false, lookup: guardedLookup() as never, signal,
    headers: { Accept: clientLogoContentTypes.join(", "), "User-Agent": "nzi-console/1.0 (client logo fetch; +https://nzi-pro-api-prod.onrender.com)" },
  }, (response) => {
    const length = Number(response.headers["content-length"]);
    resolve({
      status: response.statusCode ?? 0, location: typeof response.headers.location === "string" ? response.headers.location : null,
      contentType: response.headers["content-type"] ?? null, contentLength: Number.isFinite(length) ? length : null,
      body: response, cancel: () => response.destroy(),
    });
  });
  request.on("error", reject);
  request.end();
});

const fileNameFor = (url: URL, contentType: ClientLogoContentType) => {
  const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "").replace(/[^\w.\-]+/g, "_").slice(0, 120);
  const extension = { "image/png": "png", "image/svg+xml": "svg", "image/jpeg": "jpg", "image/webp": "webp" }[contentType];
  return last && last.includes(".") ? last : `${url.hostname}-logo.${extension}`;
};

/** Fetches a logo from `raw`, hardened as above. The bytes are validated by type when the command stores them. */
export async function fetchLogoFromUrl(raw: string, options: { fetchOnce?: FetchOnce; timeoutMs?: number } = {}): Promise<LogoFetchResult> {
  const fetchOnce = options.fetchOnce ?? httpsFetchOnce;
  const signal = AbortSignal.timeout(options.timeoutMs ?? LOGO_FETCH_TIMEOUT_MS);
  const first = checkLogoUrl(raw);
  if (!first.ok) return first;
  let url = first.url;
  try {
    for (let redirects = 0; ; redirects += 1) {
      const response = await fetchOnce(url, signal);
      if (response.status >= 300 && response.status < 400 && response.location) {
        response.cancel();
        if (redirects >= LOGO_FETCH_MAX_REDIRECTS) return fail("TOO_MANY_REDIRECTS", `The address redirected more than ${LOGO_FETCH_MAX_REDIRECTS} times.`);
        const next = checkLogoUrl(new URL(response.location, url).toString());
        if (!next.ok) return next.code === "INVALID_URL" ? fail("INVALID_URL", "The address redirected somewhere that cannot be fetched (only https, on the standard port).") : next;
        url = next.url;
        continue;
      }
      if (response.status < 200 || response.status >= 300) { response.cancel(); return fail("HTTP_STATUS", `The address answered ${response.status}, not an image.`); }
      const contentType = (response.contentType ?? "").split(";")[0]!.trim().toLowerCase();
      if (!(clientLogoContentTypes as readonly string[]).includes(contentType)) {
        response.cancel();
        return fail("NOT_AN_IMAGE", "That address is not a PNG, SVG, JPEG or WebP image.");
      }
      if (response.contentLength !== null && response.contentLength > CLIENT_LOGO_MAX_BYTES) { response.cancel(); return fail("TOO_LARGE", `The logo must be ${CLIENT_LOGO_MAX_BYTES / 1024} KB or smaller.`); }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > CLIENT_LOGO_MAX_BYTES) { response.cancel(); return fail("TOO_LARGE", `The logo must be ${CLIENT_LOGO_MAX_BYTES / 1024} KB or smaller.`); }
        chunks.push(chunk);
      }
      const typed = contentType as ClientLogoContentType;
      return { ok: true, contentType: typed, dataBase64: Buffer.concat(chunks).toString("base64"), fileName: fileNameFor(url, typed) };
    }
  } catch (error) {
    if (signal.aborted) return fail("TIMEOUT", `The address did not answer within ${(options.timeoutMs ?? LOGO_FETCH_TIMEOUT_MS) / 1000} seconds.`);
    if ((error as { code?: string }).code === "BLOCKED_ADDRESS") return fail("BLOCKED_ADDRESS", "That address is not on the public internet.");
    return fail("UNREACHABLE", "The address could not be reached.");
  }
}
