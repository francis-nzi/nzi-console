import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * The Message templates board, phase 2 of the email programme: an HTML body for the messages sent as HTML, and a preview
 * of both parts that is the send's own strict render. The HTML preview is the security-relevant part — an admin's markup is
 * shown to other admins, so it is framed with no permissions at all and never run.
 */
const here = dirname(fileURLToPath(import.meta.url));
const board = readFileSync(join(here, "../app/admin/message-templates/MessageTemplatesBoard.tsx"), "utf8");
const page = readFileSync(join(here, "../app/admin/message-templates/page.tsx"), "utf8");

describe("the Message templates board (phase 2)", () => {
  it("previews the HTML part in a sandboxed frame with no permissions — never in the console's own document", () => {
    assert.match(board, /<iframe className="nz-a-message-preview-html" title="Preview — HTML" sandbox="" srcDoc=\{email\.email\.html\} \/>/);
    assert.doesNotMatch(board, /dangerouslySetInnerHTML/, "admin-authored HTML is never injected into the page");
    assert.doesNotMatch(board, /sandbox="[^"]+"/, "the sandbox grants nothing: no scripts, forms, popups or top navigation");
  });

  it("previews with the send's own render, against the samples and the organisation's branded frame", () => {
    assert.match(board, /previewEmailTemplate\(definition, \{ subject: draft\.subject, body: draft\.body, html \}, sender\.brand\)/);
    // The page builds the brand the way a send does (5-1): the profile's settings and the console origin for the logo.
    assert.match(page, /brand: emailBrandFor\(profile\?\.fields \?\? null, process\.env\.NZI_ISOLATED_API_URL \?\? null\)/);
    // A refusal is shown as one, rather than a preview of a mail that would not be sent.
    assert.match(board, /Not sent as it stands: \{email\.issues\.join\(" "\)\}/);
  });

  it("offers an HTML body only for a message sent as HTML, and saves it only for one", () => {
    assert.match(board, /\{row\.htmlPart \? <TextAreaField label="HTML body"/);
    assert.match(board, /const content = row\.htmlPart \? \{ subject: draft\.subject, body: draft\.body, html \} : \{ subject: draft\.subject, body: draft\.body \};/);
  });

  it("checks the HTML on the screen as the command does: tokens, the required link, active content, a link at rest", () => {
    for (const check of ["messageTemplateTokenIssues(draft.html", "messageTemplateRequiredIssues(draft.html", "messageTemplateHtmlIssues(draft.html)", "messageTemplateLinkIssues(draft.html)"]) {
      assert.ok(board.includes(check), check);
    }
  });
});
