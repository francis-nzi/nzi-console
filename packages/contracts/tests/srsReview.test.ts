import assert from "node:assert/strict";
import test from "node:test";
import { commandDefinitions } from "../src/commands";
import { MESSAGE_TEMPLATE_REGISTRY } from "../src/messageTemplates";
import {
  addCalendarMonths, openSrsReviewRequest, SRS_REVIEW_TEMPLATE_KEY, srsNextReviewDate, srsReviewReminderLabel, srsReviewReminderState, srsReviewRecipient, srsReviewTiming, srsReviewValues,
  type SrsReviewCrm,
} from "../src/srsReview";

/** The SRS review loop, Phase A: the review date, when its reminder is owed, and who receives it — the CRM, never the client. */

test("a cadence resolves from the assessed date as Postgres adds months: annual +12, biannual +6, custom its date, off none", () => {
  assert.equal(srsNextReviewDate("2026-03-14", "annual"), "2027-03-14");
  assert.equal(srsNextReviewDate("2026-03-14", "biannual"), "2026-09-14");
  assert.equal(srsNextReviewDate("2026-03-14", "custom", "2026-12-01"), "2026-12-01");
  assert.equal(srsNextReviewDate("2026-03-14", "off"), null);
  assert.equal(addCalendarMonths("2024-02-29", 12), "2025-02-28", "a leap day rolls to the month's last day");
  assert.equal(addCalendarMonths("2026-08-31", 6), "2027-02-28");
  assert.equal(addCalendarMonths("2026-12-15", 1), "2027-01-15");
});

const latest = { status: "complete" as const, reviewCadence: "annual" as const, nextReviewDate: "2026-12-10", latest: true };

test("owed from review date − lead, and still owed after the date (an overdue review is worth the prompt)", () => {
  assert.deepEqual(srsReviewTiming(latest, "2026-12-02", 7), { kind: "scheduled", reviewDate: "2026-12-10", leadDays: 7, remindOn: "2026-12-03" });
  assert.deepEqual(srsReviewTiming(latest, "2026-12-03", 7), { kind: "owed", reviewDate: "2026-12-10", leadDays: 7, remindOn: "2026-12-03" });
  assert.equal(srsReviewTiming(latest, "2027-02-01", 7).kind, "owed");
});

test("never for a draft, a superseded assessment, or a cadence that is off", () => {
  assert.deepEqual(srsReviewTiming({ ...latest, status: "draft" }, "2026-12-09", 7), { kind: "none", why: "not-complete" });
  assert.deepEqual(srsReviewTiming({ ...latest, latest: false }, "2026-12-09", 7), { kind: "none", why: "superseded" });
  assert.deepEqual(srsReviewTiming({ ...latest, reviewCadence: "off", nextReviewDate: null }, "2026-12-09", 7), { kind: "none", why: "off" });
});

const crm: SrsReviewCrm = { userId: "cam", email: " Cam@NetZero.International ", status: "active", firstName: null, displayName: "Cam Manager" };

test("goes to the CRM only — active, with an address — greeted by first name; otherwise blocked and said why", () => {
  assert.deepEqual(srsReviewRecipient(crm), { ok: true, userId: "cam", email: "cam@netzero.international", firstName: "Cam" });
  assert.deepEqual(srsReviewRecipient(null), { ok: false, why: "no-crm" });
  assert.deepEqual(srsReviewRecipient({ ...crm, status: "suspended" }), { ok: false, why: "crm-inactive" });
  assert.deepEqual(srsReviewRecipient({ ...crm, email: null }), { ok: false, why: "no-email" });
});

test("the SRS area's state: sent stands whatever the switch says; off is off; a blocked reminder is shown, not dropped", () => {
  const owed = srsReviewTiming(latest, "2026-12-05", 7);
  assert.deepEqual(srsReviewReminderState({ enabled: false, timing: owed, sentForReviewDate: { enqueuedAt: "2026-12-03T08:00:00Z" }, crm }), { state: "sent", reviewDate: "2026-12-10", enqueuedAt: "2026-12-03T08:00:00Z" });
  assert.deepEqual(srsReviewReminderState({ enabled: false, timing: owed, sentForReviewDate: null, crm }), { state: "reminders-off" });
  assert.deepEqual(srsReviewReminderState({ enabled: true, timing: owed, sentForReviewDate: null, crm: null }), { state: "due", reviewDate: "2026-12-10", leadDays: 7, blocked: "no-crm" });
  assert.deepEqual(srsReviewReminderState({ enabled: true, timing: { kind: "none", why: "off" }, sentForReviewDate: null, crm }), { state: "off" });
  assert.equal(srsReviewReminderLabel({ state: "scheduled", reviewDate: "2026-12-10", remindOn: "2026-12-03", leadDays: 7, blocked: null }), "Review reminder to the client manager on 03/12/2026 (7 days before)");
  assert.equal(srsReviewReminderLabel({ state: "due", reviewDate: "2026-12-10", leadDays: 7, blocked: "no-email" }), "Review reminder due now, not sent: the client manager has no email address");
});

test("the email is a date and a link: every declared token filled, no score", () => {
  const definition = MESSAGE_TEMPLATE_REGISTRY.find((entry) => entry.key === SRS_REVIEW_TEMPLATE_KEY)!;
  assert.ok(definition.htmlPart);
  const values = srsReviewValues({ firstName: "Cam", clientName: "Northwind", assessedOn: "2025-12-10", reviewDate: "2026-12-10", srsLink: "https://x.test/clients/c?area=srs" });
  assert.deepEqual(Object.keys(values).sort(), definition.tokens.map((token) => token.name).sort());
  assert.deepEqual([values.assessedOn, values.reviewDate], ["10/12/2025", "10/12/2026"]);
  assert.ok(!definition.tokens.some((token) => /maturity|score|level/i.test(token.name)));
});

const context = { organisationId: "o", actorId: "a", principal: "staff", idempotencyKey: "k", correlationId: "c" } as never;
const definition = commandDefinitions["srs.assessment.review.set"];
const validate = (input: Record<string, unknown>) => (definition.validate as (i: unknown, c: unknown) => Array<{ field: string; code: string }>)({ assessmentId: "a", cadence: "annual", expectedVersion: 1, ...input }, context);

test("srs.assessment.review.set: srs.manage, its own audit action; a date only with custom", () => {
  assert.equal(definition.permission, "srs.manage");
  assert.equal(definition.auditAction, "srs_assessment_review_set");
  assert.deepEqual(validate({}), []);
  assert.deepEqual(validate({ cadence: "off" }), []);
  assert.deepEqual(validate({ cadence: "custom", customDate: "2027-01-31" }), []);
  assert.deepEqual(validate({ cadence: "custom" }).map((issue) => issue.field), ["customDate"]);
  assert.deepEqual(validate({ cadence: "custom", customDate: "2027-02-30" }).map((issue) => issue.field), ["customDate"]);
  assert.deepEqual(validate({ cadence: "annual", customDate: "2027-01-31" }).map((issue) => issue.field), ["customDate"]);
  assert.deepEqual(validate({ cadence: "weekly" }).map((issue) => issue.field), ["cadence"]);
  assert.deepEqual(validate({ expectedVersion: -1 }).map((issue) => issue.field), ["expectedVersion"]);
});

/* ── Phase B: the client's SRS readiness conversation ── */

const message = (seq: number, authorPrincipal: "portal" | "staff", reviewRequest = false) => ({ messageId: `m${seq}`, seq, createdAt: `2026-11-0${seq}T09:00:00Z`, authorPrincipal, ...(reviewRequest ? { reviewRequest } : {}) });

test("a review request is open until the CRM writes after it; the latest open one is surfaced", () => {
  assert.equal(openSrsReviewRequest([]), null);
  assert.equal(openSrsReviewRequest([message(1, "portal")]), null, "a plain message is not a request");
  assert.deepEqual(openSrsReviewRequest([message(1, "portal", true)]), { messageId: "m1", createdAt: "2026-11-01T09:00:00Z" });
  assert.equal(openSrsReviewRequest([message(1, "portal", true), message(2, "staff")]), null, "answered");
  assert.deepEqual(openSrsReviewRequest([message(1, "portal", true), message(2, "staff"), message(3, "portal", true), message(4, "portal")]), { messageId: "m3", createdAt: "2026-11-03T09:00:00Z" });
  assert.equal(openSrsReviewRequest([message(1, "staff", true)]), null, "only a client's message can ask");
});

const portalContext = { organisationId: "o", actorId: "p", principal: "portal", portal: { portalUserId: "p", clientId: "c" }, idempotencyKey: "k", correlationId: "c" } as never;
const issues = (key: "portal.srs.message.post" | "srs.message.post", input: Record<string, unknown>, ctx: unknown) =>
  (commandDefinitions[key].validate as (i: unknown, c: unknown) => Array<{ field: string }>)({ clientId: "c", body: "Hello", ...input }, ctx).map((issue) => issue.field);

test("portal.srs.message.post: a portal command, a message and an optional yes/no review request — nothing that names an assessment", () => {
  const definition = commandDefinitions["portal.srs.message.post"];
  assert.deepEqual([definition.principal, definition.auditAction], ["portal", "portal_srs_message_posted"]);
  assert.deepEqual(issues("portal.srs.message.post", {}, portalContext), []);
  assert.deepEqual(issues("portal.srs.message.post", { reviewRequest: true }, portalContext), []);
  assert.deepEqual(issues("portal.srs.message.post", { reviewRequest: "yes" }, portalContext), ["reviewRequest"]);
  assert.deepEqual(issues("portal.srs.message.post", { body: "  " }, portalContext), ["body"]);
});

test("srs.message.post: the CRM's reply, under srs.manage", () => {
  const definition = commandDefinitions["srs.message.post"];
  assert.deepEqual([definition.permission, definition.auditAction], ["srs.manage", "srs_message_posted"]);
  assert.deepEqual(issues("srs.message.post", {}, context), []);
  assert.deepEqual(issues("srs.message.post", { body: "" }, context), ["body"]);
});
