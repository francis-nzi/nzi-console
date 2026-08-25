import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decryptTotpSecret, encryptTotpSecret, generateTotpSecret, hashPassword, totpCode, verifyPassword, verifyTotp } from "../src/index";

describe("staff credentials", () => {
  it("hashes passwords with a per-credential salt", async () => {
    const first = await hashPassword("a sufficiently long test password");
    const second = await hashPassword("a sufficiently long test password");
    assert.notEqual(first.salt, second.salt);
    assert.equal(await verifyPassword("a sufficiently long test password", first.salt, first.hash), true);
    assert.equal(await verifyPassword("wrong password", first.salt, first.hash), false);
  });

  it("encrypts TOTP secrets with authenticated encryption", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const encrypted = encryptTotpSecret("JBSWY3DPEHPK3PXP", key);
    assert.equal(decryptTotpSecret(encrypted, key), "JBSWY3DPEHPK3PXP");
    assert.throws(() => decryptTotpSecret({ ...encrypted, tag: Buffer.alloc(16).toString("base64url") }, key));
  });

  it("verifies RFC-compatible six-digit TOTP codes with a narrow clock window", () => {
    const now = 1_700_000_000_000;
    const code = totpCode("JBSWY3DPEHPK3PXP", now);
    assert.equal(verifyTotp(code, "JBSWY3DPEHPK3PXP", now), true);
    assert.equal(verifyTotp("000000", "JBSWY3DPEHPK3PXP", now), false);
  });
  it("generates high-entropy base32 TOTP secrets", () => { assert.match(generateTotpSecret(), /^[A-Z2-7]{32}$/); });
});
