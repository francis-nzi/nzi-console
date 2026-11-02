import { randomUUID } from "node:crypto";
import { safeFileName, type PortalFileIngest } from "@nzi/contracts";
import { sha256Hex, type StorageAdapter } from "./adapter";
import { sniffUpload } from "./uploadPolicy";

/**
 * The quarantine-until-clean gate (BRIEF §2). One function every upload passes through, whoever sends it and wherever it is stored:
 *
 *   policy (size, sniffed type, executables, macros) → SHA-256 → `putQuarantined` → `scan` → `promote` | refuse | hold
 *
 * The outcome is a *record* (`PortalFileIngest`), never an exception for a refused file: a refused file is data — kept, flagged and
 * audited — not an error to swallow. Only the storage being unavailable throws (nothing is accepted that cannot be stored and scanned).
 *
 *  - **released**   — policy passed and the scan said clean; promoted out of quarantine, the only status that can be served;
 *  - **rejected**   — refused by policy before storage (no bytes kept), or infected (withdrawn from quarantine, kept, flagged);
 *  - **quarantined** — policy passed but the scan could not decide (`unknown`) or failed; held, non-servable, scanned again by `rescan`.
 */
export type GateInput = { adapter: StorageAdapter; organisationId: string; clientId: string; jobId: string | null; fileName: string; bytes: Uint8Array; fileId?: string };

export async function ingestFile({ adapter, organisationId, clientId, jobId, fileName, bytes, fileId = randomUUID() }: GateInput): Promise<PortalFileIngest> {
  const name = safeFileName(fileName);
  const sha256 = sha256Hex(bytes);
  const base = { fileId, jobId, fileName: name, sizeBytes: bytes.length, sha256, storageProvider: adapter.provider };
  const sniffed = sniffUpload(bytes, name);
  if (!sniffed.ok) return { ...base, contentType: "application/octet-stream", externalItemId: null, status: "rejected", flag: sniffed.flag, flagDetail: sniffed.detail };

  const { externalItemId } = await adapter.putQuarantined({ key: `${organisationId}/${clientId}/${fileId}`, bytes, contentType: sniffed.contentType });
  return decide(adapter, { ...base, contentType: sniffed.contentType, externalItemId });
}

/** Scan a held file again (a scanner that was still working, or had failed). Same decision as on arrival. */
export function rescanFile(adapter: StorageAdapter, held: PortalFileIngest & { externalItemId: string }): Promise<PortalFileIngest> {
  return decide(adapter, held);
}

async function decide(adapter: StorageAdapter, file: Omit<PortalFileIngest, "status" | "flag" | "flagDetail"> & { externalItemId: string | null }): Promise<PortalFileIngest> {
  const id = file.externalItemId!;
  let verdict;
  try { verdict = await adapter.scan(id); }
  catch { return { ...file, status: "quarantined", flag: "scan_failed", flagDetail: "The scan could not be run; the file is held until it can be." }; }
  if (verdict.state === "infected") {
    await adapter.deactivate(id).catch(() => undefined);
    return { ...file, status: "rejected", flag: "infected", flagDetail: verdict.detail };
  }
  if (verdict.state === "unknown") return { ...file, status: "quarantined", flag: "scan_inconclusive", flagDetail: verdict.detail };
  try {
    const promoted = await adapter.promote(id);
    return { ...file, externalItemId: promoted.externalItemId, status: "released", flag: null, flagDetail: null };
  } catch {
    // Scanned clean but could not be moved out: it stays quarantined — never served on the strength of a scan alone.
    return { ...file, status: "quarantined", flag: "scan_failed", flagDetail: "The file passed the scan but could not be released; it is held." };
  }
}
