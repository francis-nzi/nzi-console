import { randomUUID } from "node:crypto";
import type { ScanVerdict, SignedUrl, StorageAdapter } from "./adapter";

/**
 * The `local` provider: bytes held in memory, with the same quarantine / scan / promote / signed-URL contract as any other. It is the
 * development and test provider — it proves the gate against a second implementation, so the seam is real and not SharePoint-shaped —
 * and it is **not durable**: a restart loses the bytes, so it is never configured for a deployed service.
 *
 * Its scan is the standard EICAR test signature, which every real scanner also flags, so "an infected file is refused and flagged" is
 * testable without a malware engine. `scanner` can be replaced to simulate a scanner that is slow, down or says something else.
 */
// Built from two halves so this source file is not itself a detectable test file on a developer's machine.
export const eicarTestSignature = () => ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join("");
const EICAR = eicarTestSignature();

type Held = { bytes: Uint8Array; contentType: string; area: "quarantine" | "released" | "deactivated" };

export class LocalStorageAdapter implements StorageAdapter {
  readonly provider = "local" as const;
  private readonly items = new Map<string, Held>();
  private readonly urls = new Map<string, { id: string; expiresAt: number }>();
  constructor(private readonly options: { scanner?: (bytes: Uint8Array) => ScanVerdict | Promise<ScanVerdict>; now?: () => number } = {}) {}
  private now() { return (this.options.now ?? Date.now)(); }

  async putQuarantined({ bytes, contentType }: { key: string; bytes: Uint8Array; contentType: string }) {
    const externalItemId = `local-${randomUUID()}`;
    this.items.set(externalItemId, { bytes: new Uint8Array(bytes), contentType, area: "quarantine" });
    return { externalItemId };
  }

  async scan(externalItemId: string): Promise<ScanVerdict> {
    const item = this.items.get(externalItemId);
    if (!item) return { state: "unknown", detail: "The item was not found." };
    if (this.options.scanner) return this.options.scanner(item.bytes);
    return new TextDecoder("latin1").decode(item.bytes).includes(EICAR) ? { state: "infected", detail: "EICAR test signature" } : { state: "clean" };
  }

  async read(externalItemId: string): Promise<Uint8Array> {
    const item = this.items.get(externalItemId);
    if (!item) throw new Error("The item was not found.");
    return new Uint8Array(item.bytes);
  }

  async promote(externalItemId: string) {
    const item = this.items.get(externalItemId);
    if (!item || item.area !== "quarantine") throw new Error("Only a quarantined item can be promoted.");
    item.area = "released";
    return { externalItemId };
  }

  async signedUrl(externalItemId: string, ttlSeconds: number): Promise<SignedUrl> {
    const item = this.items.get(externalItemId);
    if (!item || item.area !== "released") throw new Error("That item is not available to serve.");
    const token = randomUUID();
    const expiresAt = this.now() + ttlSeconds * 1000;
    this.urls.set(token, { id: externalItemId, expiresAt });
    return { url: `local://download/${token}`, expiresAt: new Date(expiresAt).toISOString() };
  }

  async deactivate(externalItemId: string) {
    const item = this.items.get(externalItemId);
    if (item) item.area = "deactivated";
  }

  /** Test support: what following a signed URL gets — the bytes, or nothing if it has expired, is unknown, or its item is no longer servable. */
  fetchSigned(url: string): Uint8Array | null {
    const grant = this.urls.get(url.replace("local://download/", ""));
    if (!grant || grant.expiresAt <= this.now()) return null;
    const item = this.items.get(grant.id);
    return item && item.area === "released" ? item.bytes : null;
  }
  /** Test support: which area an item is in. */
  areaOf(externalItemId: string) { return this.items.get(externalItemId)?.area ?? null; }
}
