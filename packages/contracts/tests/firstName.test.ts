import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callName, commandGrantForRole, dueReminderRecipient, FIRST_NAME_FALLBACK, FIRST_NAME_MAX_LENGTH, firstNameForUpdate, firstNameToStore, firstWordOf, greetingName, reminderMessage, reminderRecipients, validateCommand } from "../src/index";

/**
 * How a person is addressed (0207): the first name addresses a person, the full name records who did something. The rule lives here once -
 * these pin it, and the places that read a name in SQL (addressName.ts) and in the chrome (staffChrome.ts) are held to the same answers.
 */
describe("the first name a person is addressed by", () => {
  it("is the first word of the full name by default, trimmed - and nothing when there is no name", () => {
    assert.equal(firstWordOf("Grace Hopper"), "Grace");
    assert.equal(firstWordOf("  Anne   Marie Lee "), "Anne");
    assert.equal(firstWordOf("Cher"), "Cher");
    assert.equal(firstWordOf("Dr. Jane Smith"), "Dr.", "a default, not a judgement - which is why the field is editable");
    for (const none of ["", "   ", null, undefined]) assert.equal(firstWordOf(none), null);
    assert.equal(firstWordOf("x".repeat(500))!.length, FIRST_NAME_MAX_LENGTH, "never longer than the column holds");
  });

  it("prefers the first name held, then the first word of the full name - never blank", () => {
    assert.equal(callName({ firstName: "Liz", fullName: "Elizabeth Windsor" }), "Liz");
    assert.equal(callName({ firstName: null, fullName: "Elizabeth Windsor" }), "Elizabeth");
    assert.equal(callName({ firstName: "   ", fullName: "Elizabeth Windsor" }), "Elizabeth", "a blank first name is not a name");
    assert.equal(callName({ fullName: "Elizabeth Windsor" }), "Elizabeth");
    assert.equal(callName({ firstName: null, fullName: null }), null, "no name at all: no name, for the caller to decide what to say");
    assert.equal(greetingName({ firstName: null, fullName: null }), FIRST_NAME_FALLBACK);
    assert.equal(greetingName({ firstName: "", fullName: "   " }), "there");
    assert.equal(greetingName({ firstName: "Liz", fullName: "Elizabeth Windsor" }), "Liz");
  });

  it("is stored as typed, or as the default when it is not given or cleared - and an update that does not mention it leaves it", () => {
    assert.equal(firstNameToStore("  Liz ", "Elizabeth Windsor"), "Liz");
    assert.equal(firstNameToStore("", "Elizabeth Windsor"), "Elizabeth", "cleared: back to the default, not to nothing");
    assert.equal(firstNameToStore(null, "Elizabeth Windsor"), "Elizabeth");
    assert.equal(firstNameToStore(undefined, "Elizabeth Windsor"), undefined, "not offered: left alone");
    assert.equal(firstNameToStore("   ", null), null, "nothing to default from");
  });

  it("follows a renamed full name only while it is still the default", () => {
    // Held == the default of the old name: it tracks.
    assert.equal(firstNameForUpdate("Rose", "Rose Franklin", "Rosalind Franklin", undefined), "Rosalind");
    assert.equal(firstNameForUpdate(null, "Rose Franklin", "Rosalind Franklin", undefined), "Rosalind", "never held: the default");
    // Held something else (somebody set it): a rename never overwrites it.
    assert.equal(firstNameForUpdate("Ros", "Rosalind Franklin", "Rosalind E. Franklin", undefined), "Ros");
    // Offered: as offered; cleared: the default of the new name.
    assert.equal(firstNameForUpdate("Rosalind", "Rosalind Franklin", "Rosalind Franklin", "Ros"), "Ros");
    assert.equal(firstNameForUpdate("Ros", "Rosalind Franklin", "Rosalind Franklin", ""), "Rosalind");
  });
});

describe("a first name on the forms is validated, and optional", () => {
  const context = { organisationId: "org-a", actorId: "u", principal: "staff" as const, idempotencyKey: "k", correlationId: "c", grant: commandGrantForRole("admin", "org-a", "u") };
  const contact = { clientId: "client-a", fullName: "Grace Hopper", isPrimary: false, roles: [] as never[] };

  it("a contact: absent, null, blank or ordinary is fine; too long or more than one line is refused with the field named", () => {
    for (const firstName of [undefined, null, "", "  ", "Grace", "Mary-Jane"]) assert.deepEqual(validateCommand("client.contact.create", { ...contact, firstName }, context), [], `${firstName}`);
    assert.ok(validateCommand("client.contact.create", { ...contact, firstName: "x".repeat(FIRST_NAME_MAX_LENGTH + 1) }, context).some((issue) => issue.field === "firstName"));
    assert.ok(validateCommand("client.contact.create", { ...contact, firstName: "Grace\nHopper" }, context).some((issue) => issue.field === "firstName"));
    assert.ok(validateCommand("client.contact.update", { ...contact, contactId: "c1", expectedVersion: 1, firstName: "x".repeat(FIRST_NAME_MAX_LENGTH + 1) }, context).some((issue) => issue.field === "firstName"));
  });

  it("the team: the same on add and on update", () => {
    const add = { displayName: "Sam Adviser", email: "sam@example.test" };
    const update = { userId: "u1", expectedVersion: 1, displayName: "Sam Adviser" };
    for (const firstName of [undefined, null, "", "Sam"]) {
      assert.deepEqual(validateCommand("staff.add", { ...add, firstName }, context), []);
      assert.deepEqual(validateCommand("staff.update", { ...update, firstName }, context), []);
    }
    assert.ok(validateCommand("staff.add", { ...add, firstName: "x".repeat(FIRST_NAME_MAX_LENGTH + 1) }, context).some((issue) => issue.field === "firstName"));
    assert.ok(validateCommand("staff.update", { ...update, firstName: "A\r\nB" }, context).some((issue) => issue.field === "firstName"));
  });
});

describe("reminders greet the contact by first name", () => {
  const contacts = [
    { email: "liz@client.example", fullName: "Elizabeth Windsor", firstName: "Liz", status: "active", emailConsent: "granted" },
    { email: "rae@client.example", fullName: "Rae Reviewer", firstName: null, status: "active", emailConsent: "granted" },
  ] as const;

  it("carries the held first name to the recipient, and the greeting uses it - not the full name", () => {
    const [liz, rae] = reminderRecipients(contacts);
    assert.equal(liz!.firstName, "Liz");
    const message = reminderMessage({ clientName: "Example Ltd", strategyTitle: "LED lighting", owner: "", targetDate: "2026-11-30", kind: "overdue", deadline: { state: "overdue" } as never, recipient: liz! });
    assert.match(message.body, /^Hello Liz,/);
    assert.doesNotMatch(message.body, /Elizabeth|Windsor/);
    // Not held: the first word of the name. No name: "there".
    assert.match(reminderMessage({ clientName: "Example Ltd", strategyTitle: "x", owner: "", targetDate: "2026-11-30", kind: "overdue", deadline: { state: "overdue" } as never, recipient: rae! }).body, /^Hello Rae,/);
    assert.match(reminderMessage({ clientName: "Example Ltd", strategyTitle: "x", owner: "", targetDate: "2026-11-30", kind: "overdue", deadline: { state: "overdue" } as never, recipient: { email: "a@b.example", name: "" } }).body, /^Hello there,/);
  });

  it("the due-date reminder's owner is greeted the same way", () => {
    const owner = { contactId: "k1", fullName: "Elizabeth Windsor", firstName: "Liz", email: "liz@client.example", status: "active", emailConsent: "granted" };
    const decided = dueReminderRecipient(owner);
    assert.ok(decided.ok && decided.firstName === "Liz");
    const unnamed = dueReminderRecipient({ ...owner, firstName: null });
    assert.ok(unnamed.ok && unnamed.firstName === "Elizabeth");
    const nobody = dueReminderRecipient({ ...owner, firstName: null, fullName: "" });
    assert.ok(nobody.ok && nobody.firstName === "there");
  });
});
