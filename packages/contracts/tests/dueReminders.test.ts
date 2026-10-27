import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commandGrantForRole, DEFAULT_REMINDER_SETTINGS, DUE_REMINDER_TEMPLATE_KEY, dueReminderRecipient, dueReminderTiming, dueReminderValues,
  emailBrandFor, messageTemplateDefinition, renderEmailTemplate, strategyReminderStatus, strategyReminderStatusLabel, strategyStatuses,
  validateCommand, type CommandContext, type ReminderOwner, type StrategyStatus,
} from "../src/index";

/**
 * Actions A3 (BUILD-actions-A3-due-date-reminders), the pure rules: when a reminder is owed (R1 — today ≥ due − lead, the
 * default 7 or the action's own; never without a date, never after it), which actions remind (R5 — Agreed and In progress
 * only), who receives it (R3 — the owner, with an address and consent; otherwise blocked and said why), what staff are
 * shown, the template it is worded by, and the commands' validation (R6).
 */

const context: CommandContext = { organisationId: "org-nzi", actorId: "user-1", principal: "staff", idempotencyKey: "idem-1", correlationId: "corr-1", grant: commandGrantForRole("admin", "org-nzi", "user-1") };
const action = (over: Partial<{ active: boolean; status: StrategyStatus; targetDate: string | null; reminderLeadDays: number | null }> = {}) =>
  ({ active: true, status: "agreed" as StrategyStatus, targetDate: "2026-11-10", reminderLeadDays: null, ...over });
const owner = (over: Partial<NonNullable<ReminderOwner>> = {}): ReminderOwner =>
  ({ contactId: "contact-1", fullName: "Dana Reid", email: "Dana@Client.example", status: "active", emailConsent: "granted", ...over });

describe("when a reminder is owed (R1)", () => {
  it("is due at due − lead, by default seven days before, and stays owed until the date itself", () => {
    assert.equal(DEFAULT_REMINDER_SETTINGS.defaultLeadDays, 7);
    assert.deepEqual(dueReminderTiming(action(), "2026-11-02", 7), { kind: "scheduled", dueDate: "2026-11-10", leadDays: 7, remindOn: "2026-11-03" });
    assert.deepEqual(dueReminderTiming(action(), "2026-11-03", 7), { kind: "owed", dueDate: "2026-11-10", leadDays: 7, remindOn: "2026-11-03" });
    assert.equal(dueReminderTiming(action(), "2026-11-10", 7).kind, "owed", "the day itself");
    assert.deepEqual(dueReminderTiming(action(), "2026-11-11", 7), { kind: "none", why: "passed" }, "after the date it would be the overdue nudge, which A3 does not add");
  });

  it("honours an action's own lead over the organisation's", () => {
    assert.equal(dueReminderTiming(action({ reminderLeadDays: 14 }), "2026-10-27", 7).kind, "owed");
    assert.equal(dueReminderTiming(action({ reminderLeadDays: 14 }), "2026-10-26", 7).kind, "scheduled");
    assert.equal(dueReminderTiming(action({ reminderLeadDays: 0 }), "2026-11-09", 7).kind, "scheduled", "0: on the day only");
    assert.equal(dueReminderTiming(action({ reminderLeadDays: 0 }), "2026-11-10", 7).kind, "owed");
    assert.equal(dueReminderTiming(action(), "2026-10-27", 14).kind, "owed", "the organisation's default, when the action has none");
  });

  it("counts calendar days across a month and a clock change", () => {
    assert.equal(dueReminderTiming(action({ targetDate: "2026-11-02" }), "2026-10-26", 7).kind, "owed", "BST ended on 25 Oct");
    assert.equal(dueReminderTiming(action({ targetDate: "2026-11-02" }), "2026-10-25", 7).kind, "scheduled");
  });

  it("never reminds an action with no date", () => {
    assert.deepEqual(dueReminderTiming(action({ targetDate: null }), "2026-11-05", 7), { kind: "none", why: "no-date" });
  });
});

describe("which actions remind (R5)", () => {
  it("Agreed and In progress only — not Proposed, Complete, Declined, or On hold", () => {
    const owed = strategyStatuses.filter((status) => dueReminderTiming(action({ status }), "2026-11-05", 7).kind === "owed");
    assert.deepEqual(owed, ["agreed", "in_progress"]);
    assert.deepEqual(dueReminderTiming(action({ status: "on_hold" }), "2026-11-05", 7), { kind: "none", why: "not-live" });
  });

  it("not an action taken off the plan", () => {
    assert.deepEqual(dueReminderTiming(action({ active: false }), "2026-11-05", 7), { kind: "none", why: "removed" });
  });
});

describe("who receives it (R3)", () => {
  it("the owner, at their address lower-cased, greeted by first name", () => {
    assert.deepEqual(dueReminderRecipient(owner()), { ok: true, contactId: "contact-1", email: "dana@client.example", firstName: "Dana" });
  });

  it("no one when there is no owner, an inactive one, no address, or no consent — and says which", () => {
    assert.deepEqual(dueReminderRecipient(null), { ok: false, why: "no-owner" });
    assert.deepEqual(dueReminderRecipient(owner({ status: "inactive" })), { ok: false, why: "owner-inactive" });
    assert.deepEqual(dueReminderRecipient(owner({ email: null })), { ok: false, why: "no-email" });
    assert.deepEqual(dueReminderRecipient(owner({ email: "  " })), { ok: false, why: "no-email" });
    assert.deepEqual(dueReminderRecipient(owner({ emailConsent: "unknown" })), { ok: false, why: "no-consent" }, "an absent decision is not permission (0083)");
    assert.deepEqual(dueReminderRecipient(owner({ emailConsent: "declined" })), { ok: false, why: "no-consent" });
  });
});

describe("what staff see (R3: skipped is surfaced, not dropped)", () => {
  const owed = dueReminderTiming(action(), "2026-11-05", 7);
  it("a blocked reminder says why", () => {
    const status = strategyReminderStatus({ enabled: true, timing: owed, sentForDueDate: null, owner: null });
    assert.deepEqual(status, { state: "due", dueDate: "2026-11-10", leadDays: 7, blocked: "no-owner" });
    assert.equal(strategyReminderStatusLabel(status), "Reminder due now, not sent: no owner is chosen");
    const later = strategyReminderStatus({ enabled: true, timing: dueReminderTiming(action(), "2026-10-20", 7), sentForDueDate: null, owner: owner({ emailConsent: "unknown" }) });
    assert.equal(strategyReminderStatusLabel(later), "Reminder due 03/11/2026 will not send: the owner has not consented to email");
  });

  it("sent stays sent, whatever the switch now says; otherwise off is off", () => {
    const sent = strategyReminderStatus({ enabled: false, timing: owed, sentForDueDate: { enqueuedAt: "2026-11-03T09:15:00.000Z" }, owner: owner() });
    assert.equal(strategyReminderStatusLabel(sent), "Reminder sent to the owner on 03/11/2026 for 10/11/2026");
    assert.deepEqual(strategyReminderStatus({ enabled: false, timing: owed, sentForDueDate: null, owner: owner() }), { state: "off" });
  });

  it("a scheduled one says when", () => {
    const status = strategyReminderStatus({ enabled: true, timing: dueReminderTiming(action(), "2026-10-20", 7), sentForDueDate: null, owner: owner() });
    assert.equal(strategyReminderStatusLabel(status), "Reminder to the owner on 03/11/2026 (7 days before)");
  });
});

describe("the template (R2)", () => {
  const entry = messageTemplateDefinition(DUE_REMINDER_TEMPLATE_KEY)!;
  const values = dueReminderValues({ firstName: "Dana", clientName: "Northwind Ltd", actionTitle: "Replace the depot boiler", dueDate: "2026-11-10", actionsLink: "https://console.example.test/portal" });
  const brand = { ...emailBrandFor(null, "https://console.example.test"), person: { signOff: "Kind regards", name: "Sam Adviser", title: "Consultant", email: "sam@netzero.international", mobile: null } };

  it("is the Admin entry for the reminder before a date, sent as HTML and text, with a link to the portal", () => {
    assert.equal(entry.key, "strategy.reminder.approaching");
    assert.equal(entry.htmlPart, true);
    const link = entry.tokens.find((token) => token.name === "actionsLink");
    assert.equal(link?.kind, "url");
    assert.notEqual(link?.required, true, "not required: wording saved before A3 has no link, and must still send");
  });

  it("renders in the house frame, signed by the adviser, naming the action and its date (dd/mm/yyyy) and linking to the portal", () => {
    const rendered = renderEmailTemplate(entry, entry.builtIn, values, { brand });
    assert.ok(rendered.ok, rendered.ok ? "" : rendered.issues.join(" "));
    if (!rendered.ok) return;
    assert.equal(rendered.email.subject, "Replace the depot boiler — due 10/11/2026");
    assert.match(rendered.email.text, /^Hello Dana,/);
    assert.match(rendered.email.text, /Northwind Ltd's reduction plan/);
    assert.match(rendered.email.text, /https:\/\/console\.example\.test\/portal/);
    assert.match(rendered.email.html, /v:roundrect[^>]*href="https:\/\/console\.example\.test\/portal"/, "the link is the house button");
    assert.match(rendered.email.html, />Sam Adviser<\/p>/, "the adviser's lines (5-2)");
    assert.match(rendered.email.html, />Net Zero International<\/p>/, "the house chrome (5-1)");
    assert.ok(!/\{\{|tCO|tonne|£|%/.test(rendered.email.text), "nothing unfilled, and no figure or money");
  });

  it("still renders an organisation's wording saved before A3 — the old tokens are all declared", () => {
    const saved = { subject: "{{strategyTitle}} — target date approaching ({{targetDate}})", body: "Hello {{firstName}},\n\n{{clientName}}: {{strategyTitle}}{{ownerLine}}\nTarget date: {{targetDate}}" };
    const rendered = renderEmailTemplate(entry, saved, values, { brand });
    assert.ok(rendered.ok, rendered.ok ? "" : rendered.issues.join(" "));
    if (rendered.ok) assert.match(rendered.email.text, /^Hello Dana,\n\nNorthwind Ltd: Replace the depot boiler\nTarget date: 10\/11\/2026/);
  });
});

describe("the commands (R1, R6)", () => {
  const update = (reminderLeadDays: unknown) => validateCommand("client.strategy.update", {
    clientStrategyId: "a-1", expectedVersion: 1, status: "agreed", progressPct: 0, srsRequirementIds: ["r-1"], includeInReport: true,
    reminderLeadDays: reminderLeadDays as number | null,
  }, context).filter((issue) => issue.field === "reminderLeadDays");

  it("an action's lead is a whole number of days from 0 to 90, or null for the default", () => {
    for (const ok of [null, 0, 7, 90]) assert.deepEqual(update(ok), [], String(ok));
    for (const bad of [-1, 91, 1.5, "7"]) assert.equal(update(bad).length, 1, String(bad));
  });

  it("the Admin settings: on or off, and a default lead from 0 to 90", () => {
    const settings = (input: Record<string, unknown>) => validateCommand("admin.reminders.update", input as never, context).map((issue) => issue.field);
    assert.deepEqual(settings({ enabled: true, defaultLeadDays: 7 }), []);
    assert.deepEqual(settings({ enabled: "yes", defaultLeadDays: 91 }), ["enabled", "defaultLeadDays"]);
  });
});
