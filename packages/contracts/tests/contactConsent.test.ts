import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  contactConsentView, isStaffRecordableBasis, staffRecordableBases,
  type ContactConsentEvent,
} from "../src/contactConsent";
import { commandDefinitions } from "../src/commands";

/**
 * Email consent. The rules worth holding: `unknown` blocks, a state is never shown without
 * the decision behind it, and staff cannot claim a client acted on their own behalf.
 */

const event = (over: Partial<ContactConsentEvent> = {}): ContactConsentEvent => ({
  id: "consent-1", contactId: "contact-a", version: 1, state: "granted", previousState: "unknown",
  basis: "consultant-recorded", note: "", recordedBy: "consultant-a", recordedAt: "2026-09-12T10:00:00Z",
  ...over,
});

describe("what a surface says about consent", () => {
  it("blocks by default, and says why rather than going quiet", () => {
    const view = contactConsentView("unknown", null);
    assert.equal(view.kind, "blocked");
    assert.equal(view.sendable, false);
    assert.match(view.detail, /No decision has been recorded/);
  });

  it("shows a grant with the basis behind it", () => {
    const view = contactConsentView("granted", event());
    assert.equal(view.kind, "sendable");
    assert.equal(view.sendable, true);
    assert.equal(view.detail, "Recorded by consultant");
  });

  it("calls out a grant with no decision behind it — the hand-edited shape", () => {
    // A bare "granted" is exactly what this control exists to replace, so it is never
    // rendered as though someone had decided it.
    const view = contactConsentView("granted", null);
    assert.equal(view.kind, "unevidenced");
    assert.match(view.detail, /No basis was recorded/);
    // And it still reports sendable, because the worker reads the column and will send.
    // Saying otherwise would be a comfortable lie on the screen while mail went out.
    assert.equal(view.sendable, true);
  });

  it("treats a stale grant event under a declined state as the decline", () => {
    const view = contactConsentView("declined", event({ state: "declined", previousState: "granted", version: 2 }));
    assert.equal(view.kind, "refused");
    assert.equal(view.sendable, false);
  });

  it("does not dress a decline up as a grant when the newest event is the old grant", () => {
    // Defensive: state and history disagreeing must resolve to the state, which is what the
    // worker reads.
    const view = contactConsentView("declined", event({ state: "granted" }));
    assert.equal(view.kind, "refused");
    assert.equal(view.sendable, false);
    if (view.kind === "refused") assert.equal(view.event, null, "and it does not cite a grant as the reason");
  });
});

describe("what staff may record", () => {
  it("offers only the bases a consultant can honestly claim", () => {
    assert.deepEqual([...staffRecordableBases], ["consultant-recorded", "imported"]);
    assert.equal(isStaffRecordableBasis("portal-self-serve"), false, "phase 2, and the contact's own action");
  });

  const validate = (input: Record<string, unknown>) =>
    commandDefinitions["client.contact.consent.record"].validate(
      input as never,
      { actorId: "consultant-a", organisationId: "org-a", idempotencyKey: "key-1", correlationId: "corr-1" } as never,
    );

  it("refuses a staff claim of portal self-serve", () => {
    const issues = validate({ contactId: "contact-a", expectedVersion: 1, state: "granted", basis: "portal-self-serve" });
    assert.ok(issues.some((issue) => issue.field === "basis"), "the console cannot record the contact's own act");
  });

  it("refuses unknown as a recordable decision", () => {
    // It is the fail-closed default — the absence of a decision, not one.
    const issues = validate({ contactId: "contact-a", expectedVersion: 1, state: "unknown", basis: "consultant-recorded" });
    assert.ok(issues.some((issue) => issue.field === "state"));
  });

  it("accepts a consultant recording a decision", () => {
    assert.deepEqual(validate({ contactId: "contact-a", expectedVersion: 1, state: "granted", basis: "consultant-recorded" }), []);
    assert.deepEqual(validate({ contactId: "contact-a", expectedVersion: 1, state: "declined", basis: "imported" }), []);
  });

  it("is gated by the capability Admin and Consultant already hold", () => {
    // contact.manage is held by exactly those two and by neither Finance nor Viewer, so a
    // second capability would have been a matrix version that changed nobody's access.
    assert.equal(commandDefinitions["client.contact.consent.record"].permission, "contact.manage");
    assert.equal(commandDefinitions["client.contact.consent.record"].auditAction, "client_contact_consent_recorded");
  });
});
