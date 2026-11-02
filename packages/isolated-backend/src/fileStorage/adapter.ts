import { createHash } from "node:crypto";
import type { FileStorageProvider } from "@nzi/contracts";

/**
 * The one storage seam (BRIEF-portal-files-secure-upload-storage §4). Every byte the portal stores goes in and out through an adapter;
 * **nothing outside an adapter may name a provider, its API, or its item ids** — the record keeps `storage_provider`, an opaque
 * `external_item_id` and the SHA-256, and a new provider is a new value of that enum plus one class implementing this.
 *
 * The lifecycle the gate drives (`fileGate.ts`): `put` into quarantine → `scan` → `promote` out of it (or `deactivate` if refused). An
 * adapter must never serve a quarantined item: `signedUrl` on one is an error, whatever the caller believes.
 */
export type ScanVerdict =
  | { state: "clean" }
  | { state: "infected"; detail: string }
  /** Not yet decidable (an asynchronous scanner has not finished). The file stays quarantined; it is scanned again later. */
  | { state: "unknown"; detail: string };

export type SignedUrl = { url: string; expiresAt: string };

export interface StorageAdapter {
  readonly provider: FileStorageProvider;
  /** Store the bytes in the non-servable quarantine area. `key` is a server-built, tenant-prefixed path; returns the provider's opaque item id. */
  putQuarantined(input: { key: string; bytes: Uint8Array; contentType: string }): Promise<{ externalItemId: string }>;
  /** The explicit scan step — a verdict, never a default. A provider that cannot decide says `unknown`, not `clean`. */
  scan(externalItemId: string): Promise<ScanVerdict>;
  /** Move a scanned-clean item out of quarantine so it can be served. Returns its (possibly new) item id. */
  promote(externalItemId: string): Promise<{ externalItemId: string }>;
  /** A time-limited URL for one access to a released item. Throws for anything still in quarantine or deactivated. */
  signedUrl(externalItemId: string, ttlSeconds: number): Promise<SignedUrl>;
  /** Withdraw an item from service (quarantined or released) — kept, never deleted. */
  deactivate(externalItemId: string): Promise<void>;
}

/** SHA-256 hex of the bytes — provider-independent, computed before the bytes leave the server, and carried on the record. */
export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The configured provider is unavailable or unconfigured. Fails closed: nothing is accepted that cannot be stored and scanned. */
export class FileStorageUnavailableError extends Error {
  constructor(message = "File storage is not available just now.") { super(message); this.name = "FileStorageUnavailableError"; }
}
