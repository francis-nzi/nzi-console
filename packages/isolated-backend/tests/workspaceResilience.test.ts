import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getClientWorkspace } from "../src/readModels";

/**
 * A peripheral read must not be able to take down the client record.
 *
 * On 15 Sep 2026 it could: migration `0084` had not been applied to staging, the consent
 * read threw, `Promise.all` rejected, and every client workspace returned 503 over a card
 * nobody was looking at. These hold the two halves of the fix — adjunct reads degrade, and
 * essential ones still fail loudly.
 */

/**
 * Matches a statement to the read it belongs to, so one read can be made to throw.
 *
 * Order matters and the client query comes first: it embeds contact and site subqueries, so
 * a looser matcher classifies the client record itself as one of its own adjuncts.
 */
const STATEMENTS: Array<[string, string]> = [
  ["FROM nzi_console.clients c", "client"],
  ["client_contact_consent_events", "contactConsent"],
  ["reviewed_crp_snapshots", "snapshots"],
  ["FROM nzi_console.client_sites", "sites"],
  ["FROM nzi_console.client_contacts", "contacts"],
  ["srs_assessments", "srs"],
  ["FROM nzi_console.client_strategies", "strategies"],
  ["report_versions", "reports"],
];

const partOf = (sql: string) => STATEMENTS.find(([needle]) => sql.includes(needle))?.[1] ?? "other";

/** A client row rich enough for the workspace to assemble around it. */
const CLIENT = {
  client_id: "client-a", version: 1, name: "Northwind Ltd", status: "active",
  sector: "Manufacturing", location: "Leeds", owner_name: "M. Osei", member_since: 2024,
  latest_footprint_tco2e: null, yoy_percent: null, completeness_percent: 50,
  next_report_due_label: "Baseline in progress", contact_name: "", contact_role: "", contact_email: "",
  open_jobs: "0", owner_user_id: null, logo_asset_id: null, primary_contact: null,
  jobs: [], sites: [],
};

const dbThrowingOn = (failing: string) => ({
  async query(sql: string) {
    if (partOf(sql) === failing) throw new Error(`relation for ${failing} does not exist`);
    if (partOf(sql) === "client") return { rows: [CLIENT] };
    return { rows: [] };
  },
});

describe("a failing adjunct read degrades its own card", () => {
  it("still returns the workspace when the consent history cannot be read", async () => {
    // The 15 Sep failure, as a test: this used to reject and become a 503.
    const workspace = await getClientWorkspace(dbThrowingOn("contactConsent") as never, "client-a");
    assert.ok(workspace, "the client record still loads");
    assert.equal(workspace.client.name, "Northwind Ltd");
  });

  it("says the consent history is unavailable rather than implying nobody decided", async () => {
    const workspace = await getClientWorkspace(dbThrowingOn("contactConsent") as never, "client-a");
    assert.ok(workspace);
    const entry = workspace.degraded.find((item) => item.part === "contactConsent");
    assert.ok(entry, "the part is named as degraded");
    assert.match(entry.reason, /unavailable/i);
    // An empty list and "could not be read" are opposite claims, so the empty fallback is
    // never presented on its own.
    assert.deepEqual(workspace.contactConsent, []);
  });

  it("fabricates nothing in place of what it could not read", async () => {
    const workspace = await getClientWorkspace(dbThrowingOn("strategies") as never, "client-a");
    assert.ok(workspace);
    assert.deepEqual(workspace.strategies.plan, []);
    assert.ok(workspace.degraded.some((item) => item.part === "strategies"));
    assert.doesNotMatch(JSON.stringify(workspace.degraded), /0%|\bnone\b/i, "a reason, not a value");
  });

  it("degrades only the part that failed, leaving the rest of the page whole", async () => {
    const workspace = await getClientWorkspace(dbThrowingOn("contactConsent") as never, "client-a");
    assert.ok(workspace);
    assert.deepEqual(workspace.degraded.map((item) => item.part), ["contactConsent"]);
  });

  it("reports nothing degraded on a healthy read", async () => {
    const healthy = { async query(sql: string) { return { rows: partOf(sql) === "client" ? [CLIENT] : [] }; } };
    const workspace = await getClientWorkspace(healthy as never, "client-a");
    assert.ok(workspace);
    assert.deepEqual(workspace.degraded, [], "the normal case carries no noise");
  });
});

describe("an essential read still fails loudly", () => {
  it("does not hide a missing footprint behind a page that looks fine", async () => {
    // A client record rendered without the measurement it rests on would look healthy while
    // being wrong — the failure mode that soft-failing everything would create.
    await assert.rejects(
      () => getClientWorkspace(dbThrowingOn("snapshots") as never, "client-a"),
      /snapshots does not exist/);
  });

  it("does not hide a missing site boundary", async () => {
    // Sites set the reporting boundary and the per-m² denominator: a footprint resolved
    // without them is a different number, quietly.
    await assert.rejects(
      () => getClientWorkspace(dbThrowingOn("sites") as never, "client-a"),
      /sites does not exist/);
  });

  it("fails when the client record itself cannot be read", async () => {
    await assert.rejects(
      () => getClientWorkspace(dbThrowingOn("client") as never, "client-a"),
      /client does not exist/);
  });
});
