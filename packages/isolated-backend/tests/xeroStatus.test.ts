import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveXeroStatus } from "../src/index";

type Status = "synced" | "pending" | "failed" | "not_configured";
const doc = (status: Status, lastSyncedAt: string | null = status === "synced" ? "2026-09-11T09:00:00.000Z" : null) => ({ xero: { status, reference: null, lastSyncedAt } });

describe("deriveXeroStatus (NZC-069, Held)", () => {
  it("reads 'Not connected' without a configured integration — whatever the documents claim", () => {
    for (const documents of [[], [doc("synced")], [doc("failed")], [doc("pending")]]) {
      assert.deepEqual(deriveXeroStatus({ configured: false }, documents), { state: "not_configured", label: "Not connected" });
    }
  });

  it("is degraded when any document failed to sync", () => {
    assert.deepEqual(deriveXeroStatus({ configured: true }, [doc("synced"), doc("failed")]), { state: "degraded", label: "Degraded · 1 document failed to sync" });
  });

  it("never reads 'Connected' on configuration alone — it needs a successful sync", () => {
    assert.deepEqual(deriveXeroStatus({ configured: true }, []), { state: "awaiting_sync", label: "Configured · awaiting first sync" });
    assert.equal(deriveXeroStatus({ configured: true }, [doc("pending"), doc("not_configured")]).state, "awaiting_sync");
    assert.equal(deriveXeroStatus({ configured: true }, [doc("synced", null)]).state, "awaiting_sync", "a synced flag without a sync time is not evidence");
  });

  it("is connected once a document has synced, counting those still awaiting sync", () => {
    assert.deepEqual(deriveXeroStatus({ configured: true }, [doc("synced")]), { state: "connected", label: "Connected" });
    assert.equal(deriveXeroStatus({ configured: true }, [doc("pending"), doc("synced")]).label, "Connected · 1 awaiting sync");
  });
});
