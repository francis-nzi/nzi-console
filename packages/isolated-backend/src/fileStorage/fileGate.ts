import { randomUUID } from "node:crypto";
import { safeFileName, type PortalFileIngest } from "@nzi/contracts";
import { sha256Hex, type StorageAdapter } from "./adapter";
import type { Scanner } from "./scanner";
import { sniffUpload } from "./uploadPolicy";

/**
 * The quarantine-until-clean gate (BRIEF §2; BRIEF-clamav-scanner). One function every upload passes through, whoever sends it and
 * wherever it is stored:
 *
 *   policy (size, sniffed type, executables, macros) → SHA-256 → `putQuarantined` → **Scanner** → (provider flag) → `promote` | refuse | hold
 *
 * The **Scanner** (ClamAV in a deployment) is authoritative for release: a file is promoted only on its positive `clean`. The storage
 * provider's own verdict is secondary, defence in depth — it can only *refuse* a file, never release one. Any error, timeout or
 * unreachable scanner is `unknown`, and `unknown` holds.
 *
 * The outcome is a *record* (`PortalFileIngest`), never an exception for a refused file: a refused file is data — kept, flagged and
 * audited — not an error to swallow. Only the storage being unavailable throws (nothing is accepted that cannot be stored and scanned).
 *
 *  - **released**   — policy passed and the scanner said clean; promoted out of quarantine, the only status that can be served;
 *  - **rejected**   — refused by policy before storage (no bytes kept), or infected (withdrawn from quarantine, kept, flagged);
 *  - **quarantined** — policy passed but the scan could not decide (`unknown`) or failed; held, non-servable, scanned again by `rescan`.
 */
export type GateInput = { adapter: StorageAdapter; scanner: Scanner; organisationId: string; clientId: string; jobId: string | null; fileName: string; bytes: Uint8Array; fileId?: string };

export async function ingestFile({ adapter, scanner, organisationId, clientId, jobId, fileName, bytes, fileId = randomUUID() }: GateInput): Promise<PortalFileIngest> {
  const name = safeFileName(fileName);
  const sha256 = sha256Hex(bytes);
  const base = { fileId, jobId, fileName: name, sizeBytes: bytes.length, sha256, storageProvider: adapter.provider };
  const sniffed = sniffUpload(bytes, name);
  if (!sniffed.ok) return { ...base, contentType: "application/octet-stream", externalItemId: null, status: "rejected", flag: sniffed.flag, flagDetail: sniffed.detail };

  const { externalItemId } = await adapter.putQuarantined({ key: `${organisationId}/${clientId}/${fileId}`, bytes, contentType: sniffed.contentType });
  return decide(adapter, scanner, { ...base, contentType: sniffed.contentType, externalItemId }, bytes);
}

/** Scan a held file again (the scanner was down, slow or had not finished). The bytes are read back from the store; same decision as on arrival. */
export async function rescanFile(adapter: StorageAdapter, scanner: Scanner, held: PortalFileIngest & { externalItemId: string }): Promise<PortalFileIngest> {
  let bytes: Uint8Array;
  try { bytes = await adapter.read(held.externalItemId); }
  catch { return { ...held, status: "quarantined", flag: "scan_failed", flagDetail: "The file could not be read back to be checked; it is held." }; }
  return decide(adapter, scanner, held, bytes);
}

async function decide(adapter: StorageAdapter, scanner: Scanner, file: Omit<PortalFileIngest, "status" | "flag" | "flagDetail"> & { externalItemId: string | null }, bytes: Uint8Array): Promise<PortalFileIngest> {
  const id = file.externalItemId!;
  const hold = (flag: "scan_inconclusive" | "scan_failed", flagDetail: string): PortalFileIngest => ({ ...file, status: "quarantined", flag, flagDetail });
  const refuseInfected = async (detail: string): Promise<PortalFileIngest> => {
    await adapter.deactivate(id).catch(() => undefined);
    return { ...file, status: "rejected", flag: "infected", flagDetail: detail };
  };

  // The authoritative scan, on the bytes the gate holds.
  let verdict;
  try { verdict = await scanner.scan(bytes); }
  catch { return hold("scan_failed", "The scan could not be run; the file is held until it can be."); }
  if (verdict.state === "infected") return refuseInfected(verdict.detail);
  if (verdict.state !== "clean") return hold("scan_inconclusive", verdict.detail);

  // Secondary: the provider's own flag may refuse a file the scanner passed. Its silence or doubt changes nothing — it cannot release.
  const secondary = await adapter.scan(id).catch(() => null);
  if (secondary?.state === "infected") return refuseInfected(secondary.detail);

  try {
    const promoted = await adapter.promote(id);
    return { ...file, externalItemId: promoted.externalItemId, status: "released", flag: null, flagDetail: null };
  } catch {
    // Scanned clean but could not be moved out: it stays quarantined — never served on the strength of a scan alone.
    return hold("scan_failed", "The file passed the scan but could not be released; it is held.");
  }
}
