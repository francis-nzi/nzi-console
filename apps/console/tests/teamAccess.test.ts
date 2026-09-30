import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { pickerMember } from "../app/lib/teamRoster";

/**
 * Team & access (admin Phase B, B1): the picker roster stops carrying work addresses. Every signed-in role reads
 * `/api/isolated/team` for the owner and manager pickers; an address is shown on Admin → Team & access alone.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(resolve(here, "..", path), "utf8");

describe("the picker roster (admin Phase B)", () => {
  it("gives a colleague's id, name, role, status and whether the name is real — never their email", () => {
    const given = pickerMember({ userId: "u1", displayName: "Ada Example", email: "ada@example.test", role: "consultant", status: "active", named: true });
    assert.deepEqual(given, { userId: "u1", displayName: "Ada Example", role: "consultant", status: "active", named: true });
    assert.ok(!JSON.stringify(given).includes("@"), "an address reached the pickers");
  });

  it("the route returns only what pickerMember gives", () => {
    const route = source("app/api/isolated/team/route.ts");
    assert.match(route, /readTeamMembers\(pool, organisationId\)\)\.map\(pickerMember\)/);
    assert.ok(!/email/i.test(route.replace(/\/\*\*[\s\S]*?\*\//g, "")), "the route's code names email");
  });

  it("the Team screen is admin.users-only, and shows addresses there alone", () => {
    const page = source("app/admin/team/page.tsx");
    assert.match(page, /holds\(access\.capabilities, "admin\.users"\)/);
    assert.match(page, /Nothing has been read/);
  });
});
