import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { portalFileHistory } from "../src/portalFiles";

/**
 * A file's History as the client reads it (RULING-portal-files-client-ui) - the mapping from the audit trail, without a database. Who is
 * "you", "a colleague" or "NZI"; the withdrawal reason is shown; nothing of staff or storage is. The scoping to the entitled user is proved
 * against a real database in `portalFilesReal`.
 */
const at = (n: number) => new Date(Date.UTC(2026, 9, 1, 9, n)).toISOString();
const row = (n: number, action: string, principal: "staff" | "portal", actor: string, extra: { reason?: string | null; after?: Record<string, unknown> } = {}) =>
  ({ actor_id: actor, principal_type: principal, action, reason: extra.reason ?? null, after_json: (extra.after ?? null) as never, occurred_at: at(n) });

describe("portalFileHistory", () => {
  it("reads an upload as uploaded, scanned and released, in order, with the scan result in words", () => {
    const entries = portalFileHistory([row(0, "portal_file_uploaded", "portal", "u1", { after: { status: "released", flag: null } })], "u1");
    assert.deepEqual(entries.map((entry) => [entry.action, entry.who, entry.detail]), [["uploaded", "you", null], ["scanned", "nzi", "Clean"], ["released", "nzi", null]]);
  });

  it("says a held upload is held, and a refused one is quarantined with the reason - and releases nothing", () => {
    const held = portalFileHistory([row(0, "portal_file_uploaded", "portal", "u1", { after: { status: "quarantined", flag: "scan_inconclusive" } })], "u1");
    assert.deepEqual(held.map((entry) => [entry.action, entry.detail]), [["uploaded", null], ["scanned", "Held while it is checked"]]);
    const refused = portalFileHistory([row(0, "portal_file_uploaded", "portal", "u1", { after: { status: "rejected", flag: "infected" } })], "u1");
    assert.deepEqual(refused.map((entry) => [entry.action, entry.detail]), [["uploaded", null], ["scanned", "Quarantined: A virus was found"]]);
  });

  it("follows a re-scan that releases the file, a download by you, a colleague and staff, and the withdrawal with its reason", () => {
    const entries = portalFileHistory([
      row(0, "portal_file_uploaded", "portal", "u1", { after: { status: "quarantined", flag: "scan_inconclusive" } }),
      row(1, "client_file_rescanned", "staff", "staff-sam", { after: { status: "released", flag: null } }),
      row(2, "portal_file_downloaded", "portal", "u1"), row(3, "portal_file_downloaded", "portal", "u2"), row(4, "client_file_downloaded", "staff", "staff-sam"),
      row(5, "client_file_deactivated", "staff", "staff-sam", { reason: "Uploaded to the wrong job" }),
    ], "u1");
    assert.deepEqual(entries.map((entry) => [entry.action, entry.who]), [
      ["uploaded", "you"], ["scanned", "nzi"], ["scanned", "nzi"], ["released", "nzi"], ["downloaded", "you"], ["downloaded", "colleague"], ["downloaded", "nzi"], ["withdrawn", "nzi"],
    ]);
    assert.equal(entries.at(-1)!.detail, "Uploaded to the wrong job");
  });

  it("reads a staff delivery as shared by NZI, and never carries a staff or storage identifier", () => {
    const entries = portalFileHistory([row(0, "client_file_delivered", "staff", "staff-sam", { after: { status: "released", flag: null, sha256: "x", fileName: "r.pdf" } }), row(1, "something_staff_only", "staff", "staff-sam")], "u1");
    assert.deepEqual(entries.map((entry) => [entry.action, entry.who]), [["shared", "nzi"], ["scanned", "nzi"], ["released", "nzi"]], "an unrelated audit action is not the client's to read");
    assert.doesNotMatch(JSON.stringify(entries), /staff-sam|sha256|r\.pdf/);
  });
});
