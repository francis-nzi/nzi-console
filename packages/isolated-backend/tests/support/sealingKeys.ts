import { randomBytes } from "node:crypto";

/**
 * Sealing keys for every suite, loaded before any of them (NZC-119).
 *
 * Writing personal data now seals it, and an unset key **refuses the write** rather than skipping it —
 * skipping is the hole the whole exercise exists to close, because the row would land unencrypted and
 * unerasable with nothing saying so. That refusal is right in production and pointless in a suite that
 * has no reason to care about encryption, so the keys are supplied once here.
 *
 * It has to be an `--import` rather than something the suites import, because the suites that write a
 * contact through a fake pool never touch the real-database helper: putting it there covered the
 * suites that needed it least. Random per run, so no value here could ever coincide with a real one.
 */
for (const variable of ["NZI_SUBJECT_MASTER_KEY", "NZI_SUBJECT_INDEX_KEY", "NZI_SUBJECT_LINKAGE_KEY"]) {
  process.env[variable] ??= randomBytes(32).toString("base64");
}
