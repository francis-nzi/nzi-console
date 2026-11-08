import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { portalLink } from "../src/portalMessageNotifications";

// F3: where a client's message-notification email points. Derived from the thread's own row, so it needs no grant to read the report.
describe("portalLink (F3)", () => {
  const origin = "https://console.example";
  it("a report-review round's thread links to the review page - a link only, no thread or version in the address", () => {
    assert.equal(portalLink(origin, "J1", "thr-rv-abc", "abc"), "https://console.example/portal/jobs/J1/review");
  });
  it("every other thread links to its conversation, as before", () => {
    assert.equal(portalLink(origin, "J1", "thr-9"), "https://console.example/portal/jobs/J1/messages?thread=thr-9");
    assert.equal(portalLink(origin, "J1", "thr-9", null), "https://console.example/portal/jobs/J1/messages?thread=thr-9");
  });
  it("a client-wide thread with no job goes to the portal home, whatever else it carries", () => {
    assert.equal(portalLink(origin, null, "thr-9"), "https://console.example/portal");
    assert.equal(portalLink(origin, null, "thr-9", "abc"), "https://console.example/portal");
  });
  it("the job id is encoded", () => {
    assert.equal(portalLink(origin, "a b/c", "t", "v"), "https://console.example/portal/jobs/a%20b%2Fc/review");
  });
});
