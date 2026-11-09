import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * SRS messaging (Phase B) in the console and the portal: the client writes only a message — the readiness read stays GET only —
 * and may ask for a review; the CRM sees the request beside Reopen / Reassess and replies under srs.manage. Dark with the
 * conversations; the client's own session only, never the staff preview.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, "..", path), "utf8");
const portalRoute = read("app/api/portal/srs-thread/route.ts");
const staffRoute = read("app/api/isolated/clients/[clientId]/srs-thread/route.ts");
const readinessRoute = read("app/api/portal/readiness/route.ts");
const readiness = read("app/portal/PortalReadiness.tsx");
const conversation = read("app/portal/PortalSrsConversation.tsx");
const area = read("app/clients/[clientId]/SrsArea.tsx");
const panel = read("app/clients/[clientId]/SrsConversation.tsx");

describe("the client's side", () => {
  it("writes a message only, through portal.srs.message.post, for the session's own client; the readiness read stays GET only", () => {
    assert.match(portalRoute, /postPortalSrsMessage\(isolatedPool\(\), \{\s*clientId: user\.clientId,/);
    assert.match(portalRoute, /requirePortalOrigin\(request\)/);
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) assert.doesNotMatch(readinessRoute, new RegExp(`export async function ${method}`));
    assert.doesNotMatch(conversation, /srs-assessments|patchBrowserCommand|putBrowserCommand/, "nothing on the portal reaches an assessment command");
  });

  it("asks for a review with a checkbox on the message, and is shown in the client's own session only, with the conversations", () => {
    assert.match(conversation, /\{ body: draft, \.\.\.\(reviewRequest \? \{ reviewRequest: true \} : \{\}\) \}/);
    assert.match(readiness, /provided===undefined&&portalFeatureEnabled\("portal-conversations"\)\?<PortalSrsConversation\/>:null/);
  });

  it("reads the adviser as the firm (NZC-110)", () => {
    assert.match(conversation, /clientAuthorLabel\(message\.author, org\.Short\)/);
    assert.doesNotMatch(conversation, /authorName/);
  });
});

describe("the CRM's side", () => {
  it("replies only through srs.message.post (srs.manage), dark with the conversations", () => {
    assert.match(staffRoute, /requireConversations\(\);\s*const principal = await requireCommandPrincipal\(request, "srs\.message\.post"\)/);
    assert.match(panel, /postBrowserCommand\(`\/api\/isolated\/clients\/\$\{encodeURIComponent\(clientId\)\}\/srs-thread`/);
    assert.match(panel, /GatedButton/);
  });

  it("surfaces an open review request beside Reopen / Reassess, and keeps the conversation in the SRS area", () => {
    assert.match(area, /<SrsReviewRequestBanner thread=\{conversation\} \/>/);
    assert.match(area, /<SrsConversation clientId=\{client\.id\} thread=\{conversation\}/);
    assert.match(area, /portalFeatureEnabled\("portal-conversations"\) \? workspace\.srs\.thread \?\? null : null/);
  });
});
