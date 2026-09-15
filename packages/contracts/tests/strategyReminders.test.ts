import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reminderMessage, reminderRecipients, remindersDue, type ClientContactLike } from "../src/strategyReminders";
import { strategyDeadline, type ClientStrategy } from "../src/reductionStrategies";

const contact = (over: Partial<ClientContactLike> = {}): ClientContactLike =>
  ({ email: "a@example.com", fullName: "Dana Reid", status: "active", emailConsent: "granted", ...over });

const strategy = (id: string, over: Partial<ClientStrategy> = {}): ClientStrategy => ({
  id, clientId: "client-a", leverIds: [], srsRequirementIds: ["req-1"], includeInReport: true,
  strategyId: null, title: id, scope: "2", category: "Energy", controlLevel: "direct_control",
  iconKey: "energy", status: "planned", owner: "", targetDate: null, progressPct: 0,
  notes: "", active: true, version: 1, estimate: null, ...over,
});

describe("who a reminder may be sent to", () => {
  it("treats an absent decision as no, not yes", () => {
    // Following training's consent_status: `unknown` holds. A client nobody has asked
    // receives nothing, which is the correct and quiet default.
    assert.deepEqual(reminderRecipients([contact({ emailConsent: "unknown" })]), []);
    assert.deepEqual(reminderRecipients([contact({ emailConsent: "declined" })]), []);
    assert.equal(reminderRecipients([contact()]).length, 1);
  });

  it("does not write to an inactive contact", () => {
    assert.deepEqual(reminderRecipients([contact({ status: "inactive" })]), []);
  });

  it("counts one inbox once, however many rows point at it", () => {
    // Two contact records sharing an address are one person; sending twice would be the
    // platform's bookkeeping leaking into someone's morning.
    const recipients = reminderRecipients([
      contact({ email: "Dana@Example.com", fullName: "Dana Reid" }),
      contact({ email: "dana@example.com", fullName: "D. Reid" }),
    ]);
    assert.deepEqual(recipients.map((r) => r.email), ["dana@example.com"]);
  });

  it("skips a contact with no usable address rather than failing the run", () => {
    assert.deepEqual(reminderRecipients([contact({ email: null }), contact({ email: "  " }), contact({ email: "nope" })]), []);
  });
});

describe("what a reminder says", () => {
  const message = (kind: "approaching" | "overdue", targetDate: string) => reminderMessage({
    clientName: "Northwind Ltd", strategyTitle: "Replace the Leeds depot boiler", owner: "Priya Shah",
    targetDate, kind, deadline: strategyDeadline(strategy("s", { targetDate }), "2026-09-14"),
    recipient: { email: "dana@example.com", name: "Dana Reid" },
  });

  it("writes dates the way the platform writes dates", () => {
    // dd/mm/yyyy (NZC-040). An ISO date in a client-facing email is a platform talking
    // to itself.
    const sent = message("overdue", "2026-09-01");
    assert.match(sent.subject, /01\/09\/2026/);
    assert.ok(!sent.body.includes("2026-09-01"));
  });

  it("carries no figure, because a strategy has none", () => {
    // Reduction strategies are qualitative (A2-lite). An email is the easiest place in the
    // platform to invent a tonnage unnoticed.
    const sent = message("approaching", "2026-09-20");
    assert.ok(!/tCO|tonne|%|kg/i.test(sent.body), sent.body);
  });

  it("asks rather than demands when a date has passed", () => {
    // A passed date is a normal event in a multi-year plan; a reminder that reads like a
    // demand makes a client defensive about telling their consultant the truth.
    const sent = message("overdue", "2026-09-01");
    assert.match(sent.body, /If the date needs to move/);
    assert.ok(!/immediately|urgent|failure|must/i.test(sent.body), sent.body);
  });

  it("greets the person, and copes when the name is one word", () => {
    assert.match(message("overdue", "2026-09-01").body, /^Hello Dana,/);
    const noName = reminderMessage({
      clientName: "N", strategyTitle: "T", owner: "", targetDate: "2026-09-01", kind: "overdue",
      deadline: strategyDeadline(strategy("s", { targetDate: "2026-09-01" }), "2026-09-14"),
      recipient: { email: "x@example.com", name: "  " },
    });
    assert.match(noName.body, /^Hello there,/);
    assert.ok(!noName.body.includes("Owner:"), "an unowned strategy does not print an empty owner");
  });
});

describe("what is owed", () => {
  it("claims the date the deadline is about, not one assumed to match", () => {
    // targetDate is part of the idempotency key, so reading it from anywhere but the
    // deadline branch would let a moved date reuse a spent claim.
    const due = remindersDue([strategy("s1", { targetDate: "2026-09-01" })], "2026-09-14");
    assert.deepEqual(due, [{ clientStrategyId: "s1", kind: "overdue", targetDate: "2026-09-01" }]);
  });

  it("owes nothing for undated, complete, removed or far-off strategies", () => {
    const due = remindersDue([
      strategy("undated"),
      strategy("done", { targetDate: "2026-01-01", status: "complete", progressPct: 100 }),
      strategy("removed", { targetDate: "2026-01-01", active: false }),
      strategy("far", { targetDate: "2027-06-01" }),
    ], "2026-09-14");
    assert.deepEqual(due, []);
  });
});
