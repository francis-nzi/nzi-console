import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { identityFor } from "../app/lib/identity";

/**
 * The rail and the Control Room greeting show whoever is signed in (was: Francis, hard-coded, for everyone).
 */

describe("who the chrome says is signed in", () => {
  it("uses the membership's name and role", () => {
    assert.deepEqual(identityFor({ userId: "u1", role: "consultant", displayName: "Jennie Davide", email: "jennie@example.org" }),
      { name: "Jennie Davide", firstName: "Jennie", initials: "JD", role: "Consultant" });
  });

  it("takes initials from the first and last names", () => {
    assert.equal(identityFor({ userId: "u2", role: "admin", displayName: "Mary Anne de Groot" }).initials, "MG");
  });

  it("falls back to the email's local part, made readable, when the name is missing", () => {
    assert.deepEqual(identityFor({ userId: "u3", role: "viewer", displayName: "  ", email: "jo.bloggs@example.org" }),
      { name: "Jo Bloggs", firstName: "Jo", initials: "JB", role: "Viewer" });
    assert.equal(identityFor({ userId: "u4", role: "viewer", displayName: null, email: "francis@example.org" }).initials, "FR");
  });

  it("falls back to the user id when there is neither name nor address", () => {
    assert.deepEqual(identityFor({ userId: "acceptance-admin", role: "admin" }),
      { name: "acceptance-admin", firstName: "acceptance-admin", initials: "AC", role: "Admin" });
  });

  it("no source file names a hard-coded user any more", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../app");
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(name) ? [full] : [];
    });
    const offenders = walk(root).filter((file) => /user=\{USER\}|export const USER\b|,\s*Francis<\/h1>/.test(readFileSync(file, "utf8")));
    assert.deepEqual(offenders, []);
  });
});
