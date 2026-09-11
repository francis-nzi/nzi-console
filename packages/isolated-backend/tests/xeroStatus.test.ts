import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveXeroStatus } from "../src/index";

const doc = (status: "synced" | "pending" | "failed" | "not_configured") => ({ xero: { status, reference: null, lastSyncedAt: null } });

describe("deriveXeroStatus (NZC-069, Open)", () => {
  it("reads 'not connected' without a configured integration — never a hard-coded 'connected'", () => {
    assert.deepEqual(deriveXeroStatus({ configured: false }, [doc("synced")]), { state: "not_configured", label: "Not connected" });
  });

  it("is degraded when any document failed to sync", () => {
    assert.deepEqual(deriveXeroStatus({ configured: true }, [doc("synced"), doc("failed")]), { state: "degraded", label: "Degraded · 1 document failed to sync" });
  });

  it("is connected, counting documents still awaiting sync", () => {
    assert.equal(deriveXeroStatus({ configured: true }, [doc("synced")]).label, "Connected");
    assert.equal(deriveXeroStatus({ configured: true }, [doc("pending"), doc("synced")]).label, "Connected · 1 awaiting sync");
  });
});
