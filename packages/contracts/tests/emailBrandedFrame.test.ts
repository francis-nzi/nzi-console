import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normaliseProfile, profileIssues, type OrganisationProfileFields } from "../src/adminOrganisation";
import {
  DEFAULT_EMAIL_CONFIDENTIALITY_NOTICE, EMAIL_BUTTON_COLOUR, emailBrandFor, MESSAGE_TEMPLATE_REGISTRY, messageTemplateDefinition, previewEmailTemplate,
  renderEmailTemplate, renderMessageText, type EmailBrand,
} from "../src/messageTemplates";

/**
 * The house email signature (email programme phase 5-1, revised to Francis's house standard): every templated email closes
 * with the fixed chrome — Net Zero International in bold, the NZI and CPD Member logos side by side at absolute https URLs,
 * the website, and the GDPR confidentiality block — after a clean body whose link is a bulletproof button. Real HTML email
 * (tables, inline styles, no stylesheet, no web font), from Organisation settings with the house values as defaults, and
 * never able to stop a send. No sign-off and no person: those are 5-2.
 */

const ORIGIN = "https://console.example.test";
const BADGE = "https://cdn.example.test/cpd-member.png";
const samples = (key: string) => Object.fromEntries(messageTemplateDefinition(key)!.tokens.map((token) => [token.name, token.sample]));
const blank: OrganisationProfileFields = {
  legalName: null, displayName: null, shortName: null, registrationNumber: null, vatNumber: null, addressLine1: null, addressLine2: null, addressCity: null,
  addressRegion: null, addressPostcode: null, addressCountry: null, contactEmail: null, contactPhone: null, websiteUrl: null, footerOverride: null,
  signatoryUserId: null, signatoryTitle: null, emailLogoUrl: null, emailBadgeUrl: null, emailConfidentialityNotice: null,
};
const profile = (fields: Partial<OrganisationProfileFields>) => ({ ...blank, ...fields });
const HTML_KEYS = MESSAGE_TEMPLATE_REGISTRY.filter((entry) => entry.htmlPart).map((entry) => entry.key);
const render = (key: string, brand: EmailBrand) => {
  const entry = messageTemplateDefinition(key)!;
  const result = renderEmailTemplate(entry, entry.builtIn, samples(key), { brand });
  if (!result.ok) throw new Error(result.issues.join(" "));
  return result.email;
};
const escapedNotice = DEFAULT_EMAIL_CONFIDENTIALITY_NOTICE; // no characters in it that escaping changes

describe("the house signature, on every templated email (R1)", () => {
  const brand = emailBrandFor(profile({ emailBadgeUrl: BADGE }), ORIGIN);

  it("closes every built-in HTML message with the company, both logos at absolute https URLs, the website and the GDPR block", () => {
    // A3: the reminder to an action's owner joins them — sent in the same frame.
    assert.deepEqual(HTML_KEYS, ["strategy.reminder.approaching", "staff.invitation", "portal.access.invite", "password.reset.staff", "password.reset.portal", "message.notification"]);
    for (const key of HTML_KEYS) {
      const { html } = render(key, brand);
      assert.match(html, /<p style="[^"]*font-weight:bold">Net Zero International<\/p>/, `${key}: the company`);
      assert.match(html, /<img src="https:\/\/console\.example\.test\/brand\/netzero-logo\.png" width="114" height="48" alt="Net Zero International"/, `${key}: the NZI logo`);
      assert.match(html, /<img src="https:\/\/cdn\.example\.test\/cpd-member\.png" height="48" alt="CPD Member"/, `${key}: the badge`);
      assert.ok(html.indexOf("netzero-logo.png") < html.indexOf("cpd-member.png"), `${key}: the NZI logo first`);
      assert.match(html, /Website: <a href="https:\/\/netzero\.international\/" style="[^"]*">netzero\.international<\/a>/, `${key}: the website`);
      assert.ok(html.includes(escapedNotice), `${key}: the GDPR block`);
      for (const src of html.match(/<img src="[^"]*"/g) ?? []) assert.match(src, /^<img src="https:\/\//, `${key}: every image absolute https`);
    }
  });

  it("puts the logos side by side in a table row — Outlook honours neither flex nor floats", () => {
    const { html } = render("message.notification", brand);
    assert.match(html, /<tr><td valign="middle"[^>]*><img src="https:\/\/console[^>]*><\/td><td valign="middle"[^>]*><img src="https:\/\/cdn[^>]*><\/td><\/tr>/);
  });

  it("is the organisation's chrome only: no sign-off, no person (R5 — the personal lines are 5-2), and no banner header", () => {
    for (const key of HTML_KEYS) {
      const { html, text } = render(key, brand);
      assert.doesNotMatch(html, /Kind regards/i, key);
      assert.doesNotMatch(text, /Kind regards/i, key);
      assert.doesNotMatch(html, /border-bottom:3px/, `${key}: no header rule`);
      assert.ok(html.indexOf("Net Zero International</p>") > html.indexOf("v:roundrect"), `${key}: the signature follows the message`);
    }
  });

  it("draws the link as a bulletproof button: VML for Outlook, a styled link for everything else, both to the link", () => {
    for (const key of HTML_KEYS) {
      const entry = messageTemplateDefinition(key)!;
      const link = entry.tokens.find((token) => token.kind === "url")!.sample;
      const { html } = render(key, brand);
      assert.match(html, new RegExp(`<v:roundrect [^>]*href="${link.replace(/[.?#]/g, "\\$&")}"[^>]*fillcolor="${EMAIL_BUTTON_COLOUR}"`), `${key}: the Outlook button`);
      assert.match(html, /<!--\[if !mso\]><!--><a href="[^"]+" style="display:inline-block;padding:12px 24px;[^"]*background:#0B7A4B">/, `${key}: the button elsewhere`);
      assert.doesNotMatch(html, /class="cta"/, `${key}: the marker becomes the button`);
      assert.doesNotMatch(html, /<p>\s*<table/, `${key}: no table inside a paragraph`);
    }
  });

  it("is real HTML email: tables, every style inline, no stylesheet, no web font", () => {
    for (const key of HTML_KEYS) {
      const { html } = render(key, brand);
      assert.doesNotMatch(html, /<style|<link\b|@import|@font-face|fonts\.googleapis|\bInter\b/i, key);
      assert.match(html, /<table role="presentation" width="100%"/);
      assert.match(html, /<table role="presentation" width="600"/);
      for (const paragraph of html.match(/<p\b[^>]*>/g) ?? []) assert.match(paragraph, /style="[^"]*font-family:Arial,Helvetica,sans-serif/, `${key}: ${paragraph}`);
      assert.match(html, /<meta name="x-apple-disable-message-reformatting">/);
    }
  });

  it("keeps the plain-text part as the message, then the signature as text — complete without the HTML", () => {
    for (const key of HTML_KEYS) {
      const entry = messageTemplateDefinition(key)!;
      const { text } = render(key, brand);
      assert.equal(text, `${renderMessageText(entry.builtIn.body, samples(key))}\n\n--\nNet Zero International\nWebsite: netzero.international\n\n${DEFAULT_EMAIL_CONFIDENTIALITY_NOTICE}`, key);
      assert.ok(text.includes(entry.tokens.find((token) => token.kind === "url")!.sample), `${key}: the link is in the text`);
    }
  });

  it("shows the same signature in the board's preview", () => {
    const entry = messageTemplateDefinition("portal.access.invite")!;
    const preview = previewEmailTemplate(entry, entry.builtIn, brand);
    assert.ok(preview.ok);
    assert.equal(preview.email.html, render("portal.access.invite", brand).html);
  });

  it("still refuses bad wording — the signature changes the look, never the strict render", () => {
    const entry = messageTemplateDefinition("password.reset.portal")!;
    const result = renderEmailTemplate(entry, { ...entry.builtIn, html: "<p>No link here</p>" }, samples("password.reset.portal"), { brand });
    assert.equal(result.ok, false);
  });
});

describe("the signature's values, from Organisation settings with the house standard as defaults (R3)", () => {
  it("defaults to the house standard: Net Zero International, the built-in NZI logo, netzero.international and the GDPR block verbatim", () => {
    assert.deepEqual(emailBrandFor(null, ORIGIN), {
      company: "Net Zero International",
      logos: [{ url: `${ORIGIN}/brand/netzero-logo.png`, alt: "Net Zero International", width: 114 }],
      website: { href: "https://netzero.international/", label: "netzero.international" },
      notice: DEFAULT_EMAIL_CONFIDENTIALITY_NOTICE,
    });
    assert.ok(DEFAULT_EMAIL_CONFIDENTIALITY_NOTICE.startsWith("Under the General Data Protection Regulation (GDPR) (EU) 2016/679, we have a legal duty"));
    assert.ok(DEFAULT_EMAIL_CONFIDENTIALITY_NOTICE.endsWith("including emptying your deleted items."));
  });

  it("takes the company, the logos, the website and the notice from settings", () => {
    const brand = emailBrandFor(profile({
      legalName: "Net Zero International Ltd", displayName: "NZI", websiteUrl: "https://www.example.test/about/", emailLogoUrl: "https://cdn.example.test/logo.png",
      emailBadgeUrl: BADGE, emailConfidentialityNotice: "Confidential — for the named recipient only.",
    }), ORIGIN);
    assert.deepEqual(brand, {
      company: "NZI",
      logos: [{ url: "https://cdn.example.test/logo.png", alt: "NZI", width: null }, { url: BADGE, alt: "CPD Member", width: null }],
      website: { href: "https://www.example.test/about/", label: "example.test/about" },
      notice: "Confidential — for the named recipient only.",
    });
    assert.equal(emailBrandFor(profile({ legalName: "Net Zero International Ltd" }), ORIGIN).company, "Net Zero International Ltd", "the legal name when there is no display name");
    const { html } = render("message.notification", brand);
    assert.ok(html.includes('<img src="https://cdn.example.test/logo.png" height="48" alt="NZI"') && html.includes("Confidential — for the named recipient only."));
  });

  it("degrades rather than blocks (R4): a logo that cannot be had is left out, the company carries the identity, the send renders", () => {
    for (const origin of [null, "http://console.example.test", "not a url"]) {
      const brand = emailBrandFor(null, origin);
      assert.deepEqual(brand.logos, [], String(origin));
      const { html, text } = render("password.reset.staff", brand);
      assert.doesNotMatch(html, /<img /);
      assert.match(html, /font-weight:bold">Net Zero International<\/p>/);
      assert.ok(text.endsWith(DEFAULT_EMAIL_CONFIDENTIALITY_NOTICE));
    }
    assert.deepEqual(emailBrandFor(null, ORIGIN).logos.map((logo) => logo.alt), ["Net Zero International"], "no badge until one is set — never a broken image");
    assert.equal(emailBrandFor(profile({ websiteUrl: "not a url" }), ORIGIN).website, null, "a website that cannot be linked is left out");
    // Everything escaped: a value from settings cannot become markup in the mail.
    const { html } = render("message.notification", emailBrandFor(profile({ displayName: "A <b>bold</b> name", emailConfidentialityNotice: "<script>x</script>" }), ORIGIN));
    assert.ok(html.includes("A &#60;b&#62;bold&#60;/b&#62; name") && !html.includes("<b>bold</b>") && !html.includes("<script>"));
  });
});

describe("the settings' rules for the signature", () => {
  const issues = (fields: Partial<OrganisationProfileFields>) => profileIssues(normaliseProfile(profile(fields))).map((issue) => `${issue.field}:${issue.code}`);

  it("want https image addresses for both logos", () => {
    assert.deepEqual(issues({ emailLogoUrl: "https://cdn.example.test/logo.png", emailBadgeUrl: BADGE }), []);
    assert.deepEqual(issues({ emailLogoUrl: "http://cdn.example.test/logo.png", emailBadgeUrl: "javascript:alert(1)" }), ["emailLogoUrl:INVALID", "emailBadgeUrl:INVALID"]);
  });

  it("hold the GDPR block to 1,000 characters — the house wording fits", () => {
    assert.deepEqual(issues({ emailConfidentialityNotice: DEFAULT_EMAIL_CONFIDENTIALITY_NOTICE }), []);
    assert.deepEqual(issues({ emailConfidentialityNotice: "x".repeat(1001) }), ["emailConfidentialityNotice:TOO_LONG"]);
  });
});
