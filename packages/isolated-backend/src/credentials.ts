import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";

const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const scrypt = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => nodeScrypt(password, salt, 64, SCRYPT_OPTIONS, (error, key) => error ? reject(error) : resolve(key as Buffer)));

export async function hashPassword(password: string, salt = randomBytes(16).toString("base64url")) {
  if (password.length < 12) throw new Error("Password must contain at least 12 characters.");
  return { salt, hash: (await scrypt(password, salt)).toString("base64url") };
}

export async function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  const actual = await scrypt(password, salt);
  const expected = Buffer.from(expectedHash, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export type EncryptedTotpSecret = { ciphertext: string; iv: string; tag: string };
const encryptionKey = (encoded: string | undefined) => {
  if (!encoded) throw new Error("NZI_CONSOLE_MFA_ENCRYPTION_KEY is required.");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("MFA encryption key must be exactly 32 bytes encoded as base64.");
  return key;
};

export function encryptTotpSecret(secret: string, encodedKey: string): EncryptedTotpSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(encodedKey), iv);
  const ciphertext = Buffer.concat([cipher.update(secret.replace(/\s/g, "").toUpperCase(), "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64url"), iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
}

export function decryptTotpSecret(value: EncryptedTotpSecret, encodedKey: string): string {
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(encodedKey), Buffer.from(value.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function generateTotpSecret(bytes = 20): string {
  const input = randomBytes(bytes);
  let bits = [...input].map((byte) => byte.toString(2).padStart(8, "0")).join("");
  let output = "";
  while (bits.length) { output += BASE32[Number.parseInt(bits.slice(0, 5).padEnd(5, "0"), 2)]; bits = bits.slice(5); }
  return output;
}
function decodeBase32(value: string): Buffer {
  const clean = value.replace(/=+$/g, "").replace(/\s/g, "").toUpperCase();
  let bits = "";
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("Invalid TOTP secret.");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  return Buffer.from(bytes);
}

export function totpCode(secret: string, nowMs = Date.now(), stepSeconds = 30): string {
  const counter = Math.floor(nowMs / 1000 / stepSeconds);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, "0");
}

export function verifyTotp(code: string, secret: string, nowMs = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  return [-1, 0, 1].some((window) => {
    const candidate = totpCode(secret, nowMs + window * 30_000);
    return timingSafeEqual(Buffer.from(code), Buffer.from(candidate));
  });
}
