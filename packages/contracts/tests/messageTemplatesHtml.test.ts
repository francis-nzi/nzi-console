import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandDefinitions } from "../src/commands";
import {
  MESSAGE_TEMPLATE_REGISTRY, messageTemplateDefinition, messageTemplateHtmlIssues, messageTemplateLinkIssues, messageTemplateRequiredIssues,
  messageTemplateTokenIssues, previewEmailTemplate, renderEmailTemplate, textToHtml, tokensIn,
} from "../src/messageTemplates";

/**
 * Message templates, phase 2 of the email programme (BUILD-message-templates-phase2): the transactional keys, HTML beside
 * the text, and the one strict render that the board's preview and `sendTemplatedEmail` share. A missing or unknown token
 * refuses; a half-rendered mail is never produced.
 */

const TRANSACTIONAL = ["staff.invitation", "portal.access.invite", "password.reset.staff", "password.reset.portal", "message.notification"];
const definition = (key: string) => messageTemplateDefinition(key)!;
const samples = (key: string) => Object.fromEntries(definition(key).tokens.map((token) => [token.name, token.sample]));
const context = { organisationId: "org", actorId: "u", principalType: "staff", reason: null, idempotencyKey: "k", correlationId: "c" } as never;
const issuesOf = (command: "message_template.create" | "message_template.update", input: Record<string, unknown>) =>
  (commandDefinitions[command].validate as (input: unknown, context: never) => { field: string; code: string }[])(input, context);

describe("the transactional keys (R3)", () => {
  it("each is sent as HTML and text, with a built-in HTML body that is sound on every check a saved one must pass", () => {
    for (const key of TRANSACTIONAL) {
      const entry = definition(key);
      assert.equal(entry.htmlPart, true, key);
      const html = entry.builtIn.html!;
      assert.ok(html, `${key} has a built-in HTML body`);
      assert.deepEqual(messageTemplateTokenIssues(html, entry), [], key);
      assert.deepEqual(messageTemplateRequiredIssues(html, entry), [], `${key}: the HTML body must carry the required link too`);
      assert.deepEqual(messageTemplateHtmlIssues(html), [], key);
      for (const part of [entry.builtIn.subject, entry.builtIn.body, html]) assert.deepEqual(messageTemplateLinkIssues(part), [], `${key}: no link at rest (R5)`);
    }
  });

  it("declares the tokens the brief names, the link required and typed as a link", () => {
    const names = (key: string) => definition(key).tokens.map((token) => token.name);
    assert.deepEqual(names("portal.access.invite"), ["displayName", "clientName", "senderName", "inviteLink", "expiresAt"]);
    assert.deepEqual(names("password.reset.staff"), ["displayName", "resetLink", "expiresAt"]);
    assert.deepEqual(names("password.reset.portal"), ["displayName", "resetLink", "expiresAt"]);
    assert.deepEqual(names("message.notification"), ["displayName", "clientName", "threadLink"]);
    assert.deepEqual(names("staff.invitation"), ["inviteLink", "expiresAt"], "one link name across every invite (phase 3; 0180 rewrote saved wording)");
    for (const [key, link] of [["portal.access.invite", "inviteLink"], ["password.reset.staff", "resetLink"], ["password.reset.portal", "resetLink"], ["message.notification", "threadLink"], ["staff.invitation", "inviteLink"]]) {
      const token = definition(key!).tokens.find((entry) => entry.name === link)!;
      assert.equal(token.required, true, key);
      assert.equal(token.kind, "url", key);
    }
  });

  it("the new-message notification carries no message content — no token for it, and its wording says so (design R10)", () => {
    const entry = definition("message.notification");
    for (const token of entry.tokens) assert.doesNotMatch(token.name, /message|body|content|subject|author|text/i, token.name);
    assert.match(entry.builtIn.body, /not in this email/);
  });

  it("the overdue reminder stays plain text: its send-site sends no HTML, so it has none to edit", () => {
    assert.equal(definition("strategy.reminder.overdue").htmlPart, undefined);
    assert.equal(definition("strategy.reminder.overdue").builtIn.html, undefined);
  });

  it("the reminder before a date is sent as HTML and text (A3): it goes through sendTemplatedEmail, so it has an HTML body", () => {
    const entry = definition("strategy.reminder.approaching");
    assert.equal(entry.htmlPart, true);
    assert.match(entry.builtIn.html!, /<a class="cta" href="\{\{actionsLink\}\}">/);
  });
});

describe("the strict render (R2, R4)", () => {
  it("renders each transactional key's subject, text and HTML from its tokens, with nothing left unfilled", () => {
    for (const key of TRANSACTIONAL) {
      const rendered = renderEmailTemplate(definition(key), definition(key).builtIn, samples(key));
      assert.ok(rendered.ok, key);
      for (const part of [rendered.email.subject, rendered.email.text, rendered.email.html]) assert.doesNotMatch(part, /\{\{|\}\}/, key);
      const link = definition(key).tokens.find((token) => token.kind === "url")!;
      assert.ok(rendered.email.text.includes(link.sample), `${key}: the text part carries the link`);
      assert.ok(rendered.email.html.includes(`href="${link.sample}"`), `${key}: the HTML part links it`);
      assert.match(rendered.email.html, /^<!doctype html>/);
    }
  });

  it("refuses a token the content uses with no value — never a blank", () => {
    const vars = { ...samples("portal.access.invite") } as Record<string, string>;
    delete vars.clientName;
    const rendered = renderEmailTemplate(definition("portal.access.invite"), definition("portal.access.invite").builtIn, vars);
    assert.equal(rendered.ok, false);
    assert.ok(!rendered.ok && rendered.issues.some((issue) => issue.includes("{{clientName}}")));
  });

  it("refuses a value for a token the message does not declare", () => {
    const rendered = renderEmailTemplate(definition("password.reset.staff"), definition("password.reset.staff").builtIn, { ...samples("password.reset.staff"), password: "x" });
    assert.ok(!rendered.ok && rendered.issues.some((issue) => issue.includes("{{password}}") && issue.includes("not a token")));
  });

  it("refuses an empty required link, and a link that is not https", () => {
    const entry = definition("password.reset.portal");
    for (const resetLink of ["", "   ", "javascript:alert(1)", "http://evil.example/reset", "not a url"]) {
      const rendered = renderEmailTemplate(entry, entry.builtIn, { ...samples("password.reset.portal"), resetLink });
      assert.equal(rendered.ok, false, JSON.stringify(resetLink));
    }
    assert.ok(renderEmailTemplate(entry, entry.builtIn, { ...samples("password.reset.portal"), resetLink: "http://localhost:3000/portal/reset#token=t" }).ok, "localhost is allowed for development");
  });

  it("refuses saved wording that has drifted: an undeclared token, or the link dropped from either part", () => {
    const entry = definition("portal.access.invite");
    assert.equal(renderEmailTemplate(entry, { ...entry.builtIn, body: "Hello {{nickname}} {{inviteLink}}" }, samples("portal.access.invite")).ok, false);
    assert.equal(renderEmailTemplate(entry, { ...entry.builtIn, html: "<p>Welcome, {{displayName}}</p>" }, samples("portal.access.invite")).ok, false, "an HTML part with no link would be the half a mail client shows");
  });

  it("escapes values into the HTML part and leaves the text part as written", () => {
    const entry = definition("message.notification");
    const rendered = renderEmailTemplate(entry, entry.builtIn, { ...samples("message.notification"), displayName: `<img src=x onerror="alert(1)">`, clientName: "Smith & Sons" });
    assert.ok(rendered.ok);
    assert.ok(!rendered.email.html.includes("<img"), "markup in a value is never live");
    assert.ok(rendered.email.html.includes("&#60;img src=x onerror=&#34;alert(1)&#34;&#62;"));
    assert.ok(rendered.email.html.includes("Smith &#38; Sons"));
    assert.ok(rendered.email.text.includes(`<img src=x onerror="alert(1)">`) && rendered.email.text.includes("Smith & Sons"), "the text part is text");
  });

  it("with no HTML body of its own, the HTML part is the text, escaped — so the two never say different things", () => {
    const entry = definition("password.reset.staff");
    const rendered = renderEmailTemplate(entry, { subject: entry.builtIn.subject, body: "Hi {{displayName}} <b>\n\n{{resetLink}}" }, samples("password.reset.staff"));
    assert.ok(rendered.ok);
    // The frame (5-1) styles each paragraph inline; the text inside is the text, escaped.
    assert.match(rendered.email.html, /<p style="[^"]*">Hi Sam Adviser &#60;b&#62;<\/p>/);
    // The link token becomes a link — a reset mail you cannot click is no better than its text part.
    const link = samples("password.reset.staff").resetLink!;
    assert.ok(rendered.email.html.includes(`<a href="${link}" style="color:#0B7A4B;word-break:break-all">${link}</a>`));
    assert.equal(textToHtml("one\ntwo\n\nthree"), "<p>one<br>two</p>\n<p>three</p>");
  });

  it("a value cannot forge a link in the HTML made from the text", () => {
    const entry = definition("password.reset.staff");
    const rendered = renderEmailTemplate(entry, { subject: "S", body: "{{displayName}} {{resetLink}}" }, { ...samples("password.reset.staff"), displayName: "\u00000\u0000" });
    assert.ok(rendered.ok);
    assert.equal((rendered.email.html.match(/<a href=/g) ?? []).length, 1, "only the link token is a link");
  });

  it("closes both parts with the organisation's footer, escaped in the HTML", () => {
    const entry = definition("message.notification");
    const rendered = renderEmailTemplate(entry, entry.builtIn, samples("message.notification"), { footer: "Net Zero International Ltd <registered in England>" });
    assert.ok(rendered.ok);
    assert.ok(rendered.email.text.endsWith("\n\n--\nNet Zero International Ltd <registered in England>"));
    assert.ok(rendered.email.html.includes("Net Zero International Ltd &#60;registered in England&#62;"));
  });

  it("the board's preview is that render against the samples only", () => {
    const entry = definition("portal.access.invite");
    assert.deepEqual(previewEmailTemplate(entry, entry.builtIn, null), renderEmailTemplate(entry, entry.builtIn, samples("portal.access.invite")));
  });

  it("every built-in still renders, the plain-text keys included", () => {
    for (const entry of MESSAGE_TEMPLATE_REGISTRY) assert.ok(renderEmailTemplate(entry, entry.builtIn, samples(entry.key)).ok, entry.key);
    assert.deepEqual(tokensIn(definition("staff.invitation").builtIn.html!).sort(), ["expiresAt", "inviteLink"]);
  });
});

describe("the commands (R5, R6)", () => {
  const base = { templateKey: "password.reset.portal", subject: "Reset", body: "Hello {{displayName}}: {{resetLink}}" };

  it("accept an HTML body for a key sent as HTML, and refuse one for a plain-text key", () => {
    assert.deepEqual(issuesOf("message_template.create", { ...base, html: "<p>{{resetLink}}</p>" }), []);
    assert.deepEqual(issuesOf("message_template.create", { ...base, html: null }), [], "none of its own is allowed");
    const plain = issuesOf("message_template.create", { templateKey: "strategy.reminder.overdue", subject: "S", body: "B {{targetDate}}", html: "<p>B</p>" });
    assert.deepEqual(plain.map((issue) => issue.code), ["NOT_SENT_AS_HTML"]);
  });

  it("refuse an HTML body with an undeclared token, without the required link, with active content, or blank", () => {
    const codes = (html: string) => issuesOf("message_template.update", { ...base, expectedVersion: 1, html }).map((issue) => issue.code);
    assert.deepEqual(codes("<p>{{resetLink}} {{secret}}</p>"), ["UNKNOWN_TOKEN"]);
    assert.deepEqual(codes("<p>Hello</p>"), ["MISSING_TOKEN"]);
    assert.deepEqual(codes(`<p>{{resetLink}}</p><script>alert(1)</script>`), ["UNSAFE_HTML"]);
    assert.deepEqual(codes(`<p onclick="x()">{{resetLink}}</p>`), ["UNSAFE_HTML"]);
    assert.deepEqual(codes(`<a href="javascript:alert(1)">{{resetLink}}</a>`), ["UNSAFE_HTML"]);
    assert.deepEqual(codes("   "), ["INVALID"]);
  });

  it("refuse a single-use link written into the wording, in any part (R5)", () => {
    const pasted = "https://console.example.test/portal/reset#token=abc123";
    assert.deepEqual(issuesOf("message_template.create", { ...base, body: `Hello {{displayName}}: {{resetLink}} or ${pasted}` }).map((issue) => issue.code), ["LINK_AT_REST"]);
    assert.deepEqual(issuesOf("message_template.create", { ...base, html: `<p>{{resetLink}}</p><a href="${pasted}">x</a>` }).map((issue) => issue.code), ["LINK_AT_REST"]);
    assert.deepEqual(issuesOf("message_template.create", { ...base, body: "Hello {{displayName}}: {{resetLink}} — see https://netzero.international for help" }), [], "an ordinary link is copy");
  });

  it("stay governed by admin.templates", () => {
    for (const command of ["message_template.create", "message_template.update", "message_template.deactivate", "message_template.reinstate"] as const) {
      assert.equal(commandDefinitions[command].permission, "admin.templates", command);
    }
  });
});
