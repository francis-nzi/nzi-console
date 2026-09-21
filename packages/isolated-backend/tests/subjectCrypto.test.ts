import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import {
  blindIndex, createSubjectKey, INDEXED_COLUMNS, openForSubject, sameIndex, sealForSubject,
  SubjectKeyShreddedError, unwrapSubjectKey, type IndexedColumn,
} from "../src/subjectCrypto";

/**
 * The two mechanisms, and the properties erasure rests on (NZC-117).
 *
 * The one that matters most is irreversibility: after a shred there must be no way back to the
 * plaintext *and* no fingerprint left that a guess could confirm. Both halves are asserted, because
 * destroying the key while leaving the index is a person still findable by anyone who can guess
 * their address.
 */

const masterKey = () => randomBytes(32).toString("base64");
const indexKey = () => randomBytes(32).toString("base64");

describe("per-subject encryption", () => {
  it("round-trips a field under that person's key", () => {
    const master = masterKey();
    const { key, wrapped } = createSubjectKey(master);
    const sealed = sealForSubject("07700 900123", key);
    assert.notEqual(sealed.ciphertext, "07700 900123");
    assert.equal(openForSubject(sealed, unwrapSubjectKey(wrapped, master)), "07700 900123");
  });

  it("gives two people different keys, so one erasure is one person", () => {
    const master = masterKey();
    const ada = createSubjectKey(master);
    const grace = createSubjectKey(master);
    assert.notEqual(ada.key.toString("base64"), grace.key.toString("base64"));
    // Ada's key cannot open Grace's field — GCM authenticates, so it fails rather than returning
    // plausible nonsense.
    const graceField = sealForSubject("Grace's address", grace.key);
    assert.throws(() => openForSubject(graceField, ada.key));
  });

  it("encrypts the same value differently every time", () => {
    // A random IV per field. Without it, two people with the same employer would be visibly
    // identical in the ciphertext, which is an inference the encryption is supposed to remove.
    const { key } = createSubjectKey(masterKey());
    const first = sealForSubject("Acme Ltd", key);
    const second = sealForSubject("Acme Ltd", key);
    assert.notEqual(first.ciphertext, second.ciphertext);
    assert.equal(openForSubject(first, key), openForSubject(second, key));
  });

  it("detects a tampered field rather than returning something plausible", () => {
    const { key } = createSubjectKey(masterKey());
    const sealed = sealForSubject("07700 900123", key);
    const flipped = { ...sealed, ciphertext: Buffer.from("07700 900999").toString("base64url") };
    assert.throws(() => openForSubject(flipped, key));
  });

  it("cannot unwrap a key that has been shredded", () => {
    // The erasure, at its simplest: the wrapped key is gone, so there is nothing to unwrap and the
    // ciphertext it protected is unreadable by anyone, including us.
    assert.throws(() => unwrapSubjectKey(null, masterKey()), SubjectKeyShreddedError);
  });

  it("cannot unwrap with the wrong master key", () => {
    const { wrapped } = createSubjectKey(masterKey());
    assert.throws(() => unwrapSubjectKey(wrapped, masterKey()));
  });

  it("refuses a key of the wrong size rather than padding it", () => {
    assert.throws(() => createSubjectKey(Buffer.from("too short").toString("base64")), /32 bytes/);
  });
});

describe("the blind index", () => {
  it("gives equal digests for values a login would treat as equal", () => {
    const key = indexKey();
    const a = blindIndex("portal_users.email_normalized", " Ada@Example.test ", key);
    const b = blindIndex("portal_users.email_normalized", "ada@example.test", key);
    assert.ok(a);
    assert.equal(a, b);
    assert.ok(sameIndex(a, b));
  });

  it("reproduces each column's own normalisation rather than sharing one", () => {
    // Listed per column so a column whose rule differs cannot quietly borrow another's. If a rule
    // changes, this is the test that has to change with it.
    for (const column of Object.keys(INDEXED_COLUMNS) as IndexedColumn[]) {
      assert.equal(INDEXED_COLUMNS[column]("  MiXeD@Case.TEST "), "mixed@case.test", column);
    }
  });

  it("domain-separates columns, so a digest from one does not confirm a value in another", () => {
    // `client_contacts` is readable by far more people than `staff_credentials`. A shared digest
    // would let a contact list confirm who has a login.
    const key = indexKey();
    const contact = blindIndex("client_contacts.email", "ada@example.test", key);
    const credential = blindIndex("staff_credentials.email_normalized", "ada@example.test", key);
    assert.notEqual(contact, credential);
  });

  it("is the same across records, which is the whole point of a global key", () => {
    const key = indexKey();
    assert.equal(
      blindIndex("trainees.personal_email", "ada@example.test", key),
      blindIndex("trainees.personal_email", "ada@example.test", key));
  });

  it("is not comparable under a different key", () => {
    assert.notEqual(
      blindIndex("trainees.personal_email", "ada@example.test", indexKey()),
      blindIndex("trainees.personal_email", "ada@example.test", indexKey()));
  });

  it("gives nothing for an absent value, which keeps the partial index partial", () => {
    // `memberships_email_once_idx` is partial: a member with no address must not collide with every
    // other member who has none.
    const key = indexKey();
    assert.equal(blindIndex("memberships.email", null, key), null);
    assert.equal(blindIndex("memberships.email", "", key), null);
    assert.equal(blindIndex("memberships.email", "   ", key), null);
    // And null never matches null, so two absent addresses are not "the same person".
    assert.equal(sameIndex(null, null), false);
  });

  it("does not reveal the address it indexes", () => {
    const key = indexKey();
    const digest = blindIndex("trainees.personal_email", "ada@example.test", key)!;
    // The address, not a fragment of it. A digest is base64url, and lower-cased it contains "ada"
    // about once in every seven hundred and eighty-five — matching the encoding rather than a leak,
    // and failing a run in a way that says the opposite of what happened. What the claim is actually
    // about is that the address cannot be read out of the digest.
    assert.match(digest, /^[A-Za-z0-9_-]+$/, "base64url, which is why a three-character needle says nothing here");
    assert.ok(!digest.toLowerCase().includes("ada@example.test"));
    assert.ok(!digest.toLowerCase().includes("example"));
    // Fixed width regardless of input length, so the digest does not leak the size of the address.
    const longer = blindIndex("trainees.personal_email", "a".repeat(200) + "@example.test", key)!;
    assert.equal(digest.length, longer.length);
  });
});

describe("what erasure has to destroy", () => {
  it("leaves no fingerprint once the key is shredded and the index nulled", () => {
    // The irreversibility property, stated over *both* halves. Destroying the key alone would leave
    // the digest behind — and a digest is confirmable by guess, so a person who asked to be
    // forgotten would still be findable by anyone who could guess their address.
    const master = masterKey();
    const index = indexKey();
    const { key, wrapped } = createSubjectKey(master);

    const stored = {
      phone: sealForSubject("07700 900123", key) as { ciphertext: string; iv: string; tag: string } | null,
      emailIndex: blindIndex("trainees.personal_email", "ada@example.test", index) as string | null,
      wrappedKey: wrapped as typeof wrapped | null,
    };

    // Before: both work.
    assert.equal(openForSubject(stored.phone!, unwrapSubjectKey(stored.wrappedKey, master)), "07700 900123");
    assert.ok(sameIndex(stored.emailIndex, blindIndex("trainees.personal_email", "ada@example.test", index)));

    // Erasure.
    stored.wrappedKey = null;
    stored.emailIndex = null;

    // After: the ciphertext is unreadable…
    assert.throws(() => unwrapSubjectKey(stored.wrappedKey, master), SubjectKeyShreddedError);
    // …and a correct guess at the address confirms nothing, because there is nothing to match.
    assert.equal(sameIndex(stored.emailIndex, blindIndex("trainees.personal_email", "ada@example.test", index)), false);
  });

  it("does not depend on the ciphertext being deleted", () => {
    // The row may stay — tombstoned, with its foreign keys and its history intact. What makes it
    // erasure is that the key is gone, not that the bytes were overwritten.
    const master = masterKey();
    const { key, wrapped } = createSubjectKey(master);
    const sealed = sealForSubject("07700 900123", key);
    const shredded: typeof wrapped | null = null;
    assert.ok(sealed.ciphertext.length > 0, "the ciphertext is still sitting there");
    assert.throws(() => openForSubject(sealed, unwrapSubjectKey(shredded, master)), SubjectKeyShreddedError);
  });
});
