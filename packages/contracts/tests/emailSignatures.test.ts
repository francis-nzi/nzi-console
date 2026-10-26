import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_EMAIL_CONFIDENTIALITY_NOTICE, emailBrandFor, emailSignatureDocument, MESSAGE_TEMPLATE_REGISTRY, messageTemplateDefinition, renderEmailTemplate,
  renderMessageText, type EmailBrand,
} from "../src/messageTemplates";
import { DEFAULT_SIGN_OFF, emailPersonFor, normaliseStaffSignature, staffSignatureIssues, type StaffSignatureFields } from "../src/staffSignature";

/**
 * Team-member signatures (email programme phase 5-2): the personal lines — Kind regards · name · title · Email · Mobile UK —
 * above 5-1's fixed chrome on an email attributed to a member, in both parts; the organisation's chrome only on a system
 * email; a missing line skipped, never a half-empty sign-off.
 */

const ORIGIN = "https://console.example.test";
const NONE: StaffSignatureFields = { title: null, displayEmail: null, mobile: null, signOff: null };
const JENNIE = { name: "Jennie Davide", positionTitle: "Consultant", workEmail: "Jennie@netzero.international" };
const samples = (key: string) => Object.fromEntries(messageTemplateDefinition(key)!.tokens.map((token) => [token.name, token.sample]));
const render = (key: string, brand: EmailBrand) => {
  const entry = messageTemplateDefinition(key)!;
  const result = renderEmailTemplate(entry, entry.builtIn, samples(key), { brand });
  if (!result.ok) throw new Error(result.issues.join(" "));
  return result.email;
};
const chrome = emailBrandFor(null, ORIGIN);
const signed = (fields: StaffSignatureFields = { title: "Customer Relationship Manager", displayEmail: null, mobile: "+44 7700 900123", signOff: null }) =>
  ({ ...chrome, person: emailPersonFor(JENNIE, fields) });

describe("the personal lines on a member-attributed email (R1)", () => {
  it("puts Kind regards, the name and the title above the company, and Email and Mobile UK beside the website", () => {
    const { html } = render("portal.access.invite", signed());
    const at = (needle: string) => { const index = html.indexOf(needle); assert.ok(index > 0, needle); return index; };
    const order = [">Kind regards</p>", ">Jennie Davide</p>", ">Customer Relationship Manager</p>", "font-weight:bold\">Net Zero International</p>",
      "netzero-logo.png", "Website: <a", "Email: <a href=\"mailto:jennie@netzero.international\"", "Mobile UK: +44 7700 900123", DEFAULT_EMAIL_CONFIDENTIALITY_NOTICE];
    for (let index = 1; index < order.length; index += 1) assert.ok(at(order[index - 1]!) < at(order[index]!), `${order[index - 1]} before ${order[index]}`);
    assert.ok(at(">Kind regards</p>") > at("v:roundrect"), "the signature follows the message");
  });

  it("carries the same lines in the plain-text part, complete on its own", () => {
    const entry = messageTemplateDefinition("portal.access.invite")!;
    const { text } = render("portal.access.invite", signed());
    assert.equal(text, `${renderMessageText(entry.builtIn.body, samples("portal.access.invite"))}\n\n--\nKind regards\n\n`
      + "Jennie Davide\nCustomer Relationship Manager\nNet Zero International\nWebsite: netzero.international\nEmail: jennie@netzero.international\nMobile UK: +44 7700 900123"
      + `\n\n${DEFAULT_EMAIL_CONFIDENTIALITY_NOTICE}`);
  });

  it("defaults an un-edited member to their name, their position and their work email — and no mobile line", () => {
    assert.deepEqual(emailPersonFor(JENNIE, NONE), { signOff: DEFAULT_SIGN_OFF, name: "Jennie Davide", title: "Consultant", email: "jennie@netzero.international", mobile: null });
    const { html, text } = render("portal.access.invite", { ...chrome, person: emailPersonFor(JENNIE, NONE) });
    assert.doesNotMatch(html, /Mobile UK/);
    assert.doesNotMatch(text, /Mobile UK/);
    assert.match(text, /Jennie Davide\nConsultant\nNet Zero International/);
  });

  it("skips a missing line rather than leaving it empty, and uses the member's own sign-off", () => {
    const person = emailPersonFor({ name: "Sam Adviser", positionTitle: null, workEmail: null }, { ...NONE, signOff: "Best wishes" });
    assert.deepEqual(person, { signOff: "Best wishes", name: "Sam Adviser", title: null, email: null, mobile: null });
    const { text, html } = render("portal.access.invite", { ...chrome, person });
    assert.match(text, /--\nBest wishes\n\nSam Adviser\nNet Zero International\nWebsite: netzero\.international\n\n/);
    assert.doesNotMatch(html, /Email: |Mobile UK: /);
  });

  it("never signs for someone with no name — the organisation's chrome alone (R3)", () => {
    assert.equal(emailPersonFor({ name: "  ", positionTitle: "Consultant", workEmail: "x@netzero.international" }, { ...NONE, mobile: "07700 900123" }), null);
  });

  it("escapes every line: a member's own text cannot become markup in the mail", () => {
    const { html } = render("portal.access.invite", { ...chrome, person: emailPersonFor({ ...JENNIE, name: "<b>J</b>" }, { ...NONE, title: "<script>x</script>" }) });
    assert.ok(!html.includes("<b>J</b>") && !html.includes("<script>") && html.includes("&#60;b&#62;J&#60;/b&#62;"));
  });
});

describe("a system email carries the organisation's chrome only (R3)", () => {
  it("has no Kind regards, no name and no personal contact lines on any built-in when no member is attributed", () => {
    for (const entry of MESSAGE_TEMPLATE_REGISTRY.filter((candidate) => candidate.htmlPart)) {
      for (const brand of [chrome, { ...chrome, person: null }]) {
        const { html, text } = render(entry.key, brand);
        assert.doesNotMatch(html, /Kind regards|Email: <a|Mobile UK/, entry.key);
        assert.doesNotMatch(text, /Kind regards|\nEmail: |Mobile UK/, entry.key);
      }
    }
  });
});

describe("the account page's preview", () => {
  it("draws the lines in the same chrome, in a document with no stylesheet and no script", () => {
    const html = emailSignatureDocument(signed());
    assert.ok(html.includes(">Jennie Davide</p>") && html.includes("font-weight:bold\">Net Zero International</p>") && html.includes(DEFAULT_EMAIL_CONFIDENTIALITY_NOTICE));
    assert.doesNotMatch(html, /<style|<script|<link\b/i);
  });
});

describe("the signature's field rules (the same as 0185's CHECKs)", () => {
  const issues = (fields: Partial<StaffSignatureFields>) => staffSignatureIssues(normaliseStaffSignature({ ...NONE, ...fields })).map((issue) => `${issue.field}:${issue.code}`);

  it("normalise: blanks to null, spaces collapsed to one line, the address lower-cased", () => {
    assert.deepEqual(normaliseStaffSignature({ title: "  ", displayEmail: " Jennie@NetZero.International ", mobile: null, signOff: "Kind\n regards" }),
      { title: null, displayEmail: "jennie@netzero.international", mobile: null, signOff: "Kind regards" });
  });

  it("refuse a bad address, a bad mobile, and text too long", () => {
    assert.deepEqual(issues({ title: "Consultant", displayEmail: "jennie@netzero.international", mobile: "+44 (0)7700 900-123", signOff: "Kind regards" }), []);
    assert.deepEqual(issues({ displayEmail: "not an address", mobile: "call me", title: "x".repeat(121), signOff: "y".repeat(61) }),
      ["title:TOO_LONG", "displayEmail:INVALID", "mobile:INVALID", "signOff:TOO_LONG"]);
  });
});
