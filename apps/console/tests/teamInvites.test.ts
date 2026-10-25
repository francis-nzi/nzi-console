import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * Staff invitations in Admin → Team & access (email programme phase 3). The invite and reinvite live on the member's row,
 * under staff.invite; the email is the default and the admin never holds the link unless they ask for one; and the
 * Platform & audit entry point is retired, pointing here instead.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, "..", path), "utf8");
const board = read("app/admin/team/TeamBoard.tsx");
const page = read("app/admin/team/page.tsx");
const route = read("app/api/isolated/staff-invitations/route.ts");
const platform = read("app/platform/PlatformBoard.tsx");

describe("staff invitations in Team & access (phase 3)", () => {
  it("offers Invite / Reinvite only to staff.invite holders, on an active member with an address, not yet enrolled, never yourself", () => {
    assert.match(page, /invite=\{holds\(access\.capabilities, "staff\.invite"\)\}/);
    assert.match(board, /const canInvite = invite && editing\.allowed;/);
    assert.match(board, /const invitable = \(row: StaffRow, self: string\) => row\.status === "active" && !!row\.email && row\.signIn !== "enrolled" && row\.userId !== self;/);
    assert.match(board, /row\.signIn === "none" \? "Invite" : "Reinvite"/);
  });

  it("emails by default, and issues a link to copy only when the admin asks — offered when the email did not reach them", () => {
    assert.match(board, /void sendInvite\(row, "email"\)/);
    assert.match(board, /row\.inviteEmail === "stubbed" \|\| row\.inviteEmail === "failed"\s*\? <button[^>]*onClick=\{\(event\) => \{ event\.stopPropagation\(\); void sendInvite\(row, "link"\); \}\}>Issue a link to copy<\/button>/);
    assert.match(board, /You do not hold the link\./);
    assert.match(route, /delivery !== "email" && body\.delivery !== "link"/);
  });

  it("an action on the row does not also open the member's drawer", () => {
    assert.equal((board.match(/event\.stopPropagation\(\); void sendInvite/g) ?? []).length, 2);
  });

  it("retires the Platform & audit invite, and says where it went", () => {
    assert.equal(existsSync(join(here, "..", "app/platform/StaffInviteAdmin.tsx")), false);
    assert.doesNotMatch(platform, /StaffInviteAdmin/);
    assert.match(platform, /<a href="\/admin\/team">Admin → Team &amp; access<\/a>/);
    assert.doesNotMatch(route, /export async function GET/, "the old picker's roster read is gone with it");
  });
});
