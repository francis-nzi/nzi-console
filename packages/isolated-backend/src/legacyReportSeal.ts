import { createHash } from "node:crypto";
import {
  createContentKey, openForDocument, sealForDocument, unwrapContentKey,
  type SealedValue, type WrappedKey,
} from "./subjectCrypto";

/**
 * Sealing an imported v7 report version (migration 0135; docs/CLIENT_JOB_IMPORT_DESIGN.md §7, decision 10).
 *
 * Each version gets its own content key, wrapped by `NZI_SUBJECT_MASTER_KEY`. The payload is v7's
 * `snapshot_json` *text* — the exact bytes v7 hashed — and is sealed whole; it is never parsed and re-serialised,
 * because re-serialising would change the bytes and break the hash that proves it unchanged. The particulars
 * (label, notes, the people who acted on it, the PDF's name and link) are sealed under the same key.
 *
 * Hash verified twice: at sealing, against v7's `data_hash` (a mismatch refuses the version rather than importing
 * something v7 would not recognise), and at opening, against the stored digest.
 */

/** The free text and names around a version. Sealed; never stored in the clear. */
export type LegacyReportParticulars = {
  versionLabel?: string | null;
  notes?: string | null;
  generatedBy?: string | null;
  reviewedBy?: string | null;
  finalizedBy?: string | null;
  supersededBy?: string | null;
  fileName?: string | null;
  filePath?: string | null;
  externalItemId?: string | null;
  externalWebUrl?: string | null;
  externalPath?: string | null;
};

export type SealedLegacyReport = {
  payloadSha256: string | null;
  payloadSealed: SealedValue | null;
  particularsSealed: SealedValue;
  contentKeyWrapped: WrappedKey;
};

export class LegacyReportHashMismatchError extends Error {
  constructor(readonly stated: string, readonly computed: string) {
    super(`v7 stated data_hash ${stated} but the payload hashes to ${computed}; the version is refused, not imported.`);
    this.name = "LegacyReportHashMismatchError";
  }
}

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export function sealLegacyReport(
  input: { payloadText: string | null; v7DataHash: string | null; particulars: LegacyReportParticulars },
  masterKey: string,
): SealedLegacyReport {
  const payloadSha256 = input.payloadText === null ? null : sha256Hex(input.payloadText);
  const stated = input.v7DataHash?.trim().toLowerCase() || null;
  if (stated !== null && stated !== payloadSha256) {
    throw new LegacyReportHashMismatchError(stated, payloadSha256 ?? "(no payload)");
  }
  const { key, wrapped } = createContentKey(masterKey);
  return {
    payloadSha256,
    payloadSealed: input.payloadText === null ? null : sealForDocument(input.payloadText, key),
    particularsSealed: sealForDocument(JSON.stringify(input.particulars), key),
    contentKeyWrapped: wrapped,
  };
}

export function openLegacyReport(
  stored: {
    payload_sealed: SealedValue | null; payload_sha256: string | null;
    particulars_sealed: SealedValue | null; content_key_wrapped: WrappedKey | null;
  },
  masterKey: string,
): { payloadText: string | null; particulars: LegacyReportParticulars | null } {
  const key = unwrapContentKey(stored.content_key_wrapped, masterKey);
  const payloadText = stored.payload_sealed ? openForDocument(stored.payload_sealed, key) : null;
  if (payloadText !== null && sha256Hex(payloadText) !== stored.payload_sha256) {
    throw new LegacyReportHashMismatchError(stored.payload_sha256 ?? "(none stored)", sha256Hex(payloadText));
  }
  const particulars = stored.particulars_sealed
    ? JSON.parse(openForDocument(stored.particulars_sealed, key)) as LegacyReportParticulars
    : null;
  return { payloadText, particulars };
}
