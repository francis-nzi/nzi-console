import type { SealingKeys } from "./piiSealing";

/**
 * Where the sealing keys come from — the one place, and the only place that reads the environment
 * for them (NZC-119).
 *
 * `piiSealing` itself takes keys as arguments and reads no environment, so the backfill, the operator
 * script and the tests can each supply their own. This module is the composition edge for the running
 * application, in the same shape as the assist configuration: the variable names live here, and
 * resolving them happens once.
 *
 * ## It fails closed, deliberately
 *
 * A missing key could either skip sealing or refuse the write. Skipping is the exact hole this work
 * exists to close — a row lands with plaintext and no ciphertext, unencrypted and unerasable, and
 * nothing anywhere says so. So an unset key stops the write, and the test harness sets all three.
 */

export const SEALING_KEY_VARIABLES = {
  masterKey: "NZI_SUBJECT_MASTER_KEY",
  indexKey: "NZI_SUBJECT_INDEX_KEY",
  linkageKey: "NZI_SUBJECT_LINKAGE_KEY",
} as const;

export class SealingKeysMissingError extends Error {
  constructor(missing: readonly string[]) {
    super(`Personal data cannot be written without its encryption keys. Unset: ${missing.join(", ")}.`);
    this.name = "SealingKeysMissingError";
  }
}

/** The three keys, or a refusal naming the ones that are absent. */
export function resolveSealingKeys(env: NodeJS.ProcessEnv = process.env): SealingKeys {
  const missing: string[] = [];
  const read = (variable: string): string => {
    const value = env[variable]?.trim();
    if (!value) missing.push(variable);
    return value ?? "";
  };
  const keys = {
    masterKey: read(SEALING_KEY_VARIABLES.masterKey),
    indexKey: read(SEALING_KEY_VARIABLES.indexKey),
    linkageKey: read(SEALING_KEY_VARIABLES.linkageKey),
  };
  if (missing.length > 0) throw new SealingKeysMissingError(missing);
  return keys;
}
