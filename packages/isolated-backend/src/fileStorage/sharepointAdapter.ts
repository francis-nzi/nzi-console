import type { ScanVerdict, SignedUrl, StorageAdapter } from "./adapter";
import { FileStorageUnavailableError } from "./adapter";

/**
 * The SharePoint / Microsoft 365 provider — **the only file that may name Graph, a drive, an item id or 365** (a test pins it). It
 * implements the adapter contract and nothing else; everything above it sees `external_item_id` as an opaque string.
 *
 * How the contract maps:
 *  - **quarantine**: the item is uploaded into a `quarantine` folder of the configured drive, and never linked from there;
 *  - **scan** (secondary only): Microsoft 365 scans uploads asynchronously and marks a detected item with a `malware` facet. Graph has
 *    no "scanned clean" signal, so this verdict is defence in depth — the gate releases on the positive `Scanner` (ClamAV), uses this
 *    only to refuse an item 365 itself flags, and never releases on it. (Its dwell-then-clean answer is therefore not a release signal);
 *  - **promote** moves the item to the `released` folder; **deactivate** moves it to `deactivated` (kept, never deleted);
 *  - **signedUrl**: Graph's pre-authenticated download URL for one access. Its lifetime is Microsoft's (short, about an hour) and cannot
 *    be shortened, so the reported expiry is the provider's, not the caller's TTL — recorded honestly rather than promised.
 *
 * Network and credentials are injected (`fetch`, a token source) so the adapter is tested against a fake Graph.
 */
export type SharePointConfig = {
  driveId: string;
  quarantineFolder?: string; releasedFolder?: string; deactivatedFolder?: string;
  /** How long an item must sit in quarantine with no malware facet before it counts as clean. */
  scanDwellSeconds?: number;
  /** The provider's own URL lifetime, as reported on a signed URL. */
  downloadUrlLifetimeSeconds?: number;
};
export type GraphAccess = { fetch: typeof fetch; token: () => Promise<string>; baseUrl?: string; now?: () => number };

const GRAPH = "https://graph.microsoft.com/v1.0";

export class SharePointStorageAdapter implements StorageAdapter {
  readonly provider = "sharepoint" as const;
  private readonly folders: { quarantine: string; released: string; deactivated: string };
  constructor(private readonly config: SharePointConfig, private readonly graph: GraphAccess) {
    this.folders = { quarantine: config.quarantineFolder ?? "quarantine", released: config.releasedFolder ?? "released", deactivated: config.deactivatedFolder ?? "deactivated" };
  }
  private now() { return (this.graph.now ?? Date.now)(); }
  private url(path: string) { return `${this.graph.baseUrl ?? GRAPH}/drives/${encodeURIComponent(this.config.driveId)}${path}`; }

  private async call(path: string, init: RequestInit & { json?: unknown; raw?: Uint8Array; contentType?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${await this.graph.token()}` };
    let body: BodyInit | undefined;
    if (init.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(init.json); }
    else if (init.raw) { headers["content-type"] = init.contentType ?? "application/octet-stream"; body = init.raw as unknown as BodyInit; }
    let response: Response;
    try { response = await this.graph.fetch(this.url(path), { method: init.method ?? "GET", headers, body }); }
    catch { throw new FileStorageUnavailableError(); }
    if (!response.ok) throw new FileStorageUnavailableError(`Microsoft 365 refused the request (${response.status}).`);
    return response;
  }

  async putQuarantined({ key, bytes, contentType }: { key: string; bytes: Uint8Array; contentType: string }) {
    const path = `/root:/${this.folders.quarantine}/${key.split("/").map(encodeURIComponent).join("/")}:/content`;
    const created = await (await this.call(path, { method: "PUT", raw: bytes, contentType })).json() as { id?: string };
    if (!created.id) throw new FileStorageUnavailableError("Microsoft 365 did not return an item id.");
    return { externalItemId: created.id };
  }

  async scan(externalItemId: string): Promise<ScanVerdict> {
    const item = await (await this.call(`/items/${encodeURIComponent(externalItemId)}?$select=id,createdDateTime,malware`)).json() as { malware?: { description?: string }; createdDateTime?: string };
    if (item.malware) return { state: "infected", detail: item.malware.description ?? "Flagged by Microsoft 365" };
    const age = (this.now() - Date.parse(item.createdDateTime ?? "")) / 1000;
    const dwell = this.config.scanDwellSeconds ?? 120;
    return Number.isFinite(age) && age >= dwell ? { state: "clean" } : { state: "unknown", detail: "Waiting for the Microsoft 365 scan to finish." };
  }

  async read(externalItemId: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.call(`/items/${encodeURIComponent(externalItemId)}/content`)).arrayBuffer());
  }

  private async move(externalItemId: string, folder: string) {
    const moved = await (await this.call(`/items/${encodeURIComponent(externalItemId)}`, { method: "PATCH", json: { parentReference: { path: `/drive/root:/${folder}` } } })).json() as { id?: string };
    return { externalItemId: moved.id ?? externalItemId };
  }
  promote(externalItemId: string) { return this.move(externalItemId, this.folders.released); }
  async deactivate(externalItemId: string) { await this.move(externalItemId, this.folders.deactivated); }

  async signedUrl(externalItemId: string, _ttlSeconds: number): Promise<SignedUrl> {
    const item = await (await this.call(`/items/${encodeURIComponent(externalItemId)}`)).json() as { parentReference?: { path?: string }; "@microsoft.graph.downloadUrl"?: string };
    // Never from quarantine or the deactivated folder, whatever the caller believes.
    if (!item.parentReference?.path?.endsWith(`/${this.folders.released}`)) throw new Error("That item is not available to serve.");
    const download = item["@microsoft.graph.downloadUrl"];
    if (!download) throw new FileStorageUnavailableError("Microsoft 365 did not return a download link.");
    return { url: download, expiresAt: new Date(this.now() + (this.config.downloadUrlLifetimeSeconds ?? 3600) * 1000).toISOString() };
  }
}

/** Client-credentials token for Graph. Only here, only SharePoint. */
export function graphTokenSource(env: { tenantId: string; clientId: string; clientSecret: string }, fetchImpl: typeof fetch = fetch): () => Promise<string> {
  let cached: { token: string; until: number } | null = null;
  return async () => {
    if (cached && cached.until > Date.now() + 60_000) return cached.token;
    const response = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(env.tenantId)}/oauth2/v2.0/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.clientId, client_secret: env.clientSecret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
    }).catch(() => null);
    if (!response?.ok) throw new FileStorageUnavailableError();
    const body = await response.json() as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new FileStorageUnavailableError();
    cached = { token: body.access_token, until: Date.now() + (body.expires_in ?? 3000) * 1000 };
    return body.access_token;
  };
}
