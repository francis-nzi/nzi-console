import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Encrypting personal data so that erasure is the destruction of a key (NZC-117).
 *
 * Two mechanisms, because personal data is used in two ways, and one mechanism cannot serve both.
 *
 * **Display-only data is encrypted per subject.** A phone number is shown and never searched, so it
 * becomes ciphertext under that person's own key. Destroy the key and every such field for that
 * person is unreadable at once, wherever it sits, without touching the rows themselves.
 *
 * **Operational data gets a blind index as well.** An address that a login resolves, or that a
 * unique constraint enforces, has to be matchable without being readable. So alongside the
 * ciphertext sits a keyed HMAC of the normalised value: equal inputs give equal digests, and the
 * digest reveals nothing without the key. The lineage is `verify_certificate_attempts`, which
 * counts rate-limit attempts against a salted hash precisely so that verifying a certificate leaves
 * no address in the database.
 *
 * ## Why the index key is global and the data keys are not
 *
 * A blind index has to be comparable *across* records — that is its whole purpose, and a per-subject
 * index key would produce a different digest for the same address in every row, which is the same
 * as having no index. So the index key is one key for the estate.
 *
 * That has a consequence worth stating rather than discovering: anyone holding the index key can
 * ask "is this address present?" of the whole estate. They cannot read an address, and they cannot
 * enumerate — a digest is not reversible — but a guess is confirmable. That is the price of being
 * able to log someone in, and it is why the index is **nulled on erasure**: an erased person must
 * not leave behind a fingerprint that a guess could still confirm.
 *
 * Data keys are the opposite: one per subject, because destroying one must not affect anybody else.
 *
 * ## Keys enter at the edge
 *
 * Nothing here reads `process.env`. Both keys are arguments, so the one place a secret enters the
 * process stays greppable and every test runs with keys it made up — the discipline `answerModel`
 * and `credentials` already follow.
 */

/** A per-subject data key, as stored: wrapped by the master key, and meaningless without it. */
export type WrappedKey = { ciphertext: string; iv: string; tag: string };

/** A field at rest: ciphertext under a subject's key. */
export type SealedValue = { ciphertext: string; iv: string; tag: string };

const KEY_BYTES = 32;
const IV_BYTES = 12;

const keyFrom = (encoded: string, what: string): Buffer => {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== KEY_BYTES) throw new Error(`${what} must be exactly 32 bytes encoded as base64.`);
  return key;
};

const seal = (plaintext: string, key: Buffer): SealedValue => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
};

const unseal = (value: SealedValue, key: Buffer): string => {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64url")), decipher.final()]).toString("utf8");
};

/* ── Per-subject data keys ───────────────────────────────────────────────────────────── */

/** A new data key for one person, wrapped ready to store. Never returned unwrapped by accident. */
export function createSubjectKey(masterKey: string): { key: Buffer; wrapped: WrappedKey } {
  const key = randomBytes(KEY_BYTES);
  return { key, wrapped: seal(key.toString("base64"), keyFrom(masterKey, "The master key")) };
}

/**
 * A subject's key, recovered from storage.
 *
 * Throws when the wrapped key is gone, and that is the erasure working: after a shred there is
 * nothing to unwrap, so the ciphertext it protected can no longer be read by anyone — including us.
 */
export function unwrapSubjectKey(wrapped: WrappedKey | null, masterKey: string): Buffer {
  if (!wrapped) throw new SubjectKeyShreddedError();
  return Buffer.from(unseal(wrapped, keyFrom(masterKey, "The master key")), "base64");
}

export class SubjectKeyShreddedError extends Error {
  constructor() {
    super("That person's key has been destroyed; their data cannot be read.");
    this.name = "SubjectKeyShreddedError";
  }
}

/** Encrypt one display-only field under a subject's key. */
export const sealForSubject = (plaintext: string, subjectKey: Buffer): SealedValue => seal(plaintext, subjectKey);

/** Read one field back. Throws if the ciphertext was tampered with — GCM authenticates. */
export const openForSubject = (value: SealedValue, subjectKey: Buffer): string => unseal(value, subjectKey);

/* ── The blind index ─────────────────────────────────────────────────────────────────── */

/**
 * How each operational column normalises, reproduced exactly.
 *
 * The digest has to be computed over the same string the old constraint compared, or uniqueness
 * changes meaning at the moment of encryption: `staff_credentials` and `portal_users` enforced
 * `lower(trim(…))` with a CHECK, `trainees` had a unique index on the raw column, and
 * `memberships` indexed `lower(btrim(email))`. They are listed rather than assumed, so a column
 * whose rule differs cannot quietly borrow another's.
 */
export const INDEXED_COLUMNS = {
  "staff_credentials.email_normalized": (value: string) => value.trim().toLowerCase(),
  "portal_users.email_normalized": (value: string) => value.trim().toLowerCase(),
  "trainees.personal_email": (value: string) => value.trim().toLowerCase(),
  "client_contacts.email": (value: string) => value.trim().toLowerCase(),
  "memberships.email": (value: string) => value.trim().toLowerCase(),
  "trainee_email_changes.current_email": (value: string) => value.trim().toLowerCase(),
  "trainee_email_changes.new_email": (value: string) => value.trim().toLowerCase(),
} as const;

export type IndexedColumn = keyof typeof INDEXED_COLUMNS;

/**
 * The searchable digest of one value, for one column.
 *
 * Domain-separated by column name, so the same address in two columns gives two digests. Without
 * that, a digest taken from one table would confirm a value in another — and `client_contacts`
 * is readable by more people than `staff_credentials` is.
 *
 * Returns null for an absent value, which is what keeps the partial unique index on
 * `memberships.email` partial: a member with no address must not collide with every other member
 * who has none.
 */
export function blindIndex(column: IndexedColumn, value: string | null | undefined, indexKey: string): string | null {
  const normalise = INDEXED_COLUMNS[column];
  const normalised = normalise(String(value ?? ""));
  if (normalised === "") return null;
  return createHmac("sha256", keyFrom(indexKey, "The blind index key"))
    .update(`${column}:${normalised}`)
    .digest("base64url");
}

/* ── The linkage digest ──────────────────────────────────────────────────────────────── */

/**
 * One digest for one address, shared across the person-tables — and confined to the linker
 * (NZC-118).
 *
 * The column digests above are domain-separated on purpose, so a digest taken from
 * `client_contacts` cannot confirm who holds a staff login. That separation is what makes them
 * safe, and it is also why the subject linker cannot use them: the same address in two tables
 * produces two different digests, which is exactly the comparison the linker needs to make.
 *
 * So linkage gets its own digest, deliberately *not* domain-separated by table — and it is confined
 * three ways instead:
 *
 * 1. **Its own key.** Holding the column-index key does not let anyone compute a linkage digest, so
 *    the ability to log someone in does not carry the ability to correlate them across the estate.
 * 2. **Its own table**, which the application role cannot read. It is reachable only through the
 *    privileged function the linker and the DPO path use — the `NZC-100` lineage: where a policy
 *    cannot confine a thing, privilege does.
 * 3. **Nulled on erasure**, alongside the operational digests, so an erased person leaves no
 *    correlatable trace either.
 *
 * It normalises the same way the columns do, because it has to agree with them about what "the
 * same address" means.
 */
export const LINKAGE_DOMAIN = "subject-linkage";

export function linkageDigest(value: string | null | undefined, linkageKey: string): string | null {
  const normalised = String(value ?? "").trim().toLowerCase();
  if (normalised === "") return null;
  return createHmac("sha256", keyFrom(linkageKey, "The linkage key"))
    .update(`${LINKAGE_DOMAIN}:${normalised}`)
    .digest("base64url");
}

/* ── Normalisation at rest ───────────────────────────────────────────────────────────── */

/**
 * The form an address is stored in (NZC-118).
 *
 * Four database CHECKs used to assert that an address equalled its own lower-cased, trimmed form.
 * Ciphertext cannot satisfy that, so 0100 dropped them — which moved an invariant out of the
 * database and into the application, where nothing was holding it.
 *
 * It is held here, and the choice is to **keep normalising at rest** rather than to store what was
 * typed. Every write path already normalises before writing, and the portal session hands
 * `email_normalized` to the application as the user's address, so storing the as-entered form would
 * change what a signed-in user sees — a behaviour change smuggled inside an encryption migration,
 * which is the one thing this work must not do. The digest normalises too, so the two agree by
 * construction rather than by coincidence.
 */
export const normaliseEmailAtRest = (email: string): string => email.trim().toLowerCase();

/** Compare two digests without leaking where they differ. */
export const sameIndex = (a: string | null, b: string | null): boolean => {
  if (a === null || b === null) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
