import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MESSAGE_TEMPLATE_KEY_PATTERN, MESSAGE_TEMPLATE_REGISTRY, messageTemplateDefinition, messageTemplateRequiredIssues, messageTemplateTokenIssues, previewMessage, renderMessage, tokensIn,
} from "../src/messageTemplates";
import { reminderMessage } from "../src/strategyReminders";

/**
 * Message templates (admin F1; ruled F-Q2/F-Q3): the registry of keys, declared tokens, the sample-only preview — and
 * the built-in wording, which must be exactly what the send-sites composed before F1, so that an organisation with no
 * template of its own sends what it always sent.
 */
const reminder = (kind: "approaching" | "overdue", owner: string, name: string) => reminderMessage({
  clientName: "Acme Ltd", strategyTitle: "Switch to LED lighting", owner, targetDate: "2026-11-30", kind,
  deadline: undefined as never, recipient: { name, email: "x@example.test" },
});

describe("the registry", () => {
  it("names each key once, in the key pattern, with a send-site, and built-in wording that uses only declared tokens", () => {
    const keys = MESSAGE_TEMPLATE_REGISTRY.map((definition) => definition.key);
    assert.deepEqual(keys, ["strategy.reminder.approaching", "strategy.reminder.overdue", "staff.invitation"]);
    assert.equal(new Set(keys).size, keys.length);
    for (const definition of MESSAGE_TEMPLATE_REGISTRY) {
      assert.match(definition.key, MESSAGE_TEMPLATE_KEY_PATTERN);
      assert.ok(definition.sendSite.trim(), `${definition.key} has no send-site`);
      for (const text of [definition.builtIn.subject, definition.builtIn.body]) assert.deepEqual(messageTemplateTokenIssues(text, definition), [], definition.key);
      assert.deepEqual(messageTemplateRequiredIssues(definition.builtIn.body, definition), [], `${definition.key}: the built-in body lacks a required token`);
      for (const token of definition.tokens) assert.ok(token.sample !== "" && token.description.trim(), `${definition.key}.${token.name} has no sample or description`);
      for (const [v7Token, token] of Object.entries(definition.v7?.tokens ?? {})) assert.ok(definition.tokens.some((entry) => entry.name === token), `${definition.key}: v7 ${v7Token} maps to an undeclared ${token}`);
    }
  });
});

describe("the built-in wording is what the send-sites sent before F1, word for word", () => {
  // Frozen from reminderMessage() as it stood before F1 (captured, not retyped).
  it("the approaching reminder, with an owner and without (no name → \"there\")", () => {
    assert.deepEqual(reminder("approaching", "Sam Owner", "Grace Hopper"), {
      subject: "Switch to LED lighting — target date approaching (30/11/2026)",
      body: "Hello Grace,\n\nThe target date for this action in Acme Ltd's reduction plan is 30/11/2026.\n\nAction: Switch to LED lighting\nOwner: Sam Owner\nTarget date: 30/11/2026\n\nIf the date needs to move, or it is already done, let your consultant know.\n\nYou can see your full plan in your client portal.\n\n— NZ Insights Pro",
    });
    assert.deepEqual(reminder("approaching", "  ", ""), {
      subject: "Switch to LED lighting — target date approaching (30/11/2026)",
      body: "Hello there,\n\nThe target date for this action in Acme Ltd's reduction plan is 30/11/2026.\n\nAction: Switch to LED lighting\nTarget date: 30/11/2026\n\nIf the date needs to move, or it is already done, let your consultant know.\n\nYou can see your full plan in your client portal.\n\n— NZ Insights Pro",
    });
  });

  it("the overdue reminder, with an owner and without", () => {
    assert.deepEqual(reminder("overdue", "Sam Owner", "Alan Turing"), {
      subject: "Switch to LED lighting — target date passed (30/11/2026)",
      body: "Hello Alan,\n\nThe target date for this action in Acme Ltd's reduction plan was 30/11/2026, and it is not yet marked complete.\n\nAction: Switch to LED lighting\nOwner: Sam Owner\nTarget date: 30/11/2026\n\nIf it is done, your consultant can mark it complete. If the date needs to move, tell them — a date that has moved is more useful than a date that has passed.\n\nYou can see your full plan in your client portal.\n\n— NZ Insights Pro",
    });
    assert.equal(reminder("overdue", "", "Ada").body.includes("Owner:"), false);
  });

  it("the staff invitation", () => {
    const definition = messageTemplateDefinition("staff.invitation")!;
    assert.deepEqual(renderMessage(definition.builtIn, { link: "https://c.test/enrol#token=t", expiresAt: "2026-10-04T09:00:00.000Z" }), {
      subject: "Set up your NZ Insights Pro sign-in",
      body: [
        "You have been invited to the NZ Insights Pro staff console.",
        "",
        "Set your own password and connect your authenticator here:",
        "https://c.test/enrol#token=t",
        "",
        "This link works once and expires at 2026-10-04T09:00:00.000Z. Nobody at NZI sees your password or your authenticator.",
        "If you were not expecting this, ignore it — nothing happens unless the link is used.",
      ].join("\n"),
    });
  });

  it("an organisation's own template replaces the built-in wording", () => {
    const own = reminderMessage({ clientName: "Acme Ltd", strategyTitle: "LEDs", owner: "", targetDate: "2026-11-30", kind: "overdue", deadline: undefined as never, recipient: { name: "Ada Lovelace", email: "x@example.test" } },
      { subject: "Overdue: {{strategyTitle}}", body: "Dear {{firstName}}, {{clientName}} missed {{targetDate}}." });
    assert.deepEqual(own, { subject: "Overdue: LEDs", body: "Dear Ada, Acme Ltd missed 30/11/2026." });
  });
});

describe("tokens and the preview (F-Q2)", () => {
  const definition = messageTemplateDefinition("strategy.reminder.approaching")!;

  it("refuses a token the key does not declare, and stray braces — naming the token, never echoing the text", () => {
    assert.deepEqual(messageTemplateTokenIssues("Hi {{firstName}} {{password}}", definition), ["{{password}} is not a token this message supplies."]);
    assert.deepEqual(messageTemplateTokenIssues("{{a}} {{b}}", definition), ["{{a}}, {{b}} are not tokens this message supplies."]);
    assert.deepEqual(messageTemplateTokenIssues("Hi {{firstName}", definition), ["A {{ or }} that is not part of a token — tokens are written {{name}}."]);
    assert.deepEqual(messageTemplateTokenIssues("Hi {{ firstName }}", definition), ["{{ firstName }} is not a token this message supplies."], "a token is written exactly");
    assert.deepEqual(tokensIn("{{a}} {{b}} {{a}}"), ["a", "b"]);
  });

  it("requires a body to use the tokens a message cannot do without — an invitation needs its link", () => {
    const invitation = messageTemplateDefinition("staff.invitation")!;
    assert.deepEqual(messageTemplateRequiredIssues("Welcome. Expires {{expiresAt}}.", invitation), ["The body must include {{link}} — the single-use enrolment link."]);
    assert.deepEqual(messageTemplateRequiredIssues("Go to {{link}}", invitation), []);
  });

  it("previews against the registry's samples only", () => {
    const shown = previewMessage({ subject: "{{strategyTitle}}", body: "Hello {{firstName}} at {{clientName}}" }, definition);
    assert.deepEqual(shown, { subject: "Switch to LED lighting", body: "Hello Grace at Example Manufacturing Ltd" });
  });
});
