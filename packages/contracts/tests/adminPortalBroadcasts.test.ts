import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAllowedBroadcastLink, isBroadcastInstant, portalBroadcastPhase } from "../src/adminPortalBroadcasts";

/** Portal broadcasts (admin F4): the link allow-list (R3) and where a broadcast stands in its window (R4). */
describe("a broadcast's link (R3)", () => {
  it("allows https:// addresses and the console's own paths, and nothing else", () => {
    for (const ok of ["https://example.org/guide", "https://example.org", "/portal", "/portal/jobs/1?tab=report", "/"]) assert.equal(isAllowedBroadcastLink(ok), true, ok);
    for (const bad of ["http://example.org", "javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "mailto:a@b.test", "//evil.test/x", "/\\evil.test",
      "https://", "https:/example.org", "ftp://example.org", " https://example.org", "https://exa mple.org", "portal/jobs", ""]) {
      assert.equal(isAllowedBroadcastLink(bad), false, bad);
    }
  });
});

describe("a broadcast's window (R4)", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  it("is live from its start until (not at) its end; open-ended without one; inactive whatever its window", () => {
    assert.equal(portalBroadcastPhase({ active: true, startsAt: "2026-10-02T12:00:00Z", endsAt: null }, now), "live", "live at its start");
    assert.equal(portalBroadcastPhase({ active: true, startsAt: "2026-10-01T12:00:00Z", endsAt: "2026-10-02T12:00:00Z" }, now), "ended", "the end is exclusive");
    assert.equal(portalBroadcastPhase({ active: true, startsAt: "2026-10-03T12:00:00Z", endsAt: null }, now), "scheduled");
    assert.equal(portalBroadcastPhase({ active: false, startsAt: "2026-10-01T12:00:00Z", endsAt: null }, now), "inactive");
  });

  it("takes instants with a zone, as the API carries them", () => {
    assert.equal(isBroadcastInstant("2026-10-02T12:00:00.000Z"), true);
    assert.equal(isBroadcastInstant("2026-10-02T13:00:00+01:00"), true);
    assert.equal(isBroadcastInstant("2026-10-02T12:00"), false, "a London clock reading is converted by the screen, not sent");
    assert.equal(isBroadcastInstant("2026-10-02"), false);
  });
});
