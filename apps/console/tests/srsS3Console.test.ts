import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * SRS S3 in the console: the AI route checks who may ask — and for which client — before it spends a call, calls the
 * model outside any transaction and only then records; ideas are labelled as AI wherever they appear and never applied by
 * themselves; the report draws its sections from the template and records its export before the browser prints it.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, "..", path), "utf8");
const suggestions = read("app/api/isolated/srs-assessments/[assessmentId]/gaps/[requirementId]/suggestions/route.ts");
const bridgeRoute = read("app/api/isolated/srs-assessments/[assessmentId]/gaps/[requirementId]/bridge/route.ts");
const bridgeForm = read("app/clients/[clientId]/SrsBridgeForm.tsx");
const portal = read("app/portal/PortalReadiness.tsx");
const reportPage = read("app/clients/[clientId]/srs-report/page.tsx");
const reportDocument = read("app/clients/[clientId]/srs-report/SrsReportDocument.tsx");
const reportPrint = read("app/clients/[clientId]/srs-report/SrsReportPrint.tsx");
const reportRoute = read("app/api/isolated/clients/[clientId]/srs-report/route.ts");

describe("AI ideas: gated before they cost, grounded, labelled, never applied", () => {
  it("checks the capability and the client before the model is called, then records after it", () => {
    const at = (needle: string) => suggestions.indexOf(needle);
    assert.ok(at('requireCommandPrincipal(request, "srs.gap.suggestions.record")') > -1);
    assert.ok(at("requireCommandPrincipal") < at("assertCapabilityOnClient(db, principal, \"srs.manage\""), "capability first");
    assert.ok(at("assertCapabilityOnClient") < at("generateSrsGapSuggestions("), "the client before the model");
    assert.ok(at("generateSrsGapSuggestions(") < at("recordSrsGapSuggestions("), "the model before the record");
    assert.ok(suggestions.indexOf("withTenantRead") < at("generateSrsGapSuggestions("), "the read closes before the call: no model call inside a transaction");
    assert.match(suggestions, /const apiKey = process\.env\.ANTHROPIC_API_KEY;/, "the key is read at the composition edge");
    assert.match(suggestions, /code: "AI_OFF"/, "without a key, AI is plainly off — not an error, not an empty answer");
  });

  it("labels ideas as AI wherever they are shown, and turns one into an action only through a person", () => {
    assert.match(bridgeForm, /Ideas from AI <span className="nz-tag nz-ai-tag">AI<\/span>/);
    assert.match(bridgeForm, /The client sees the ideas shown here in their portal, labelled as AI/);
    // "Use this idea" fills the consultant's own form; only "Add as the bridge" writes.
    assert.match(bridgeForm, /onClick=\{\(\) => \{ setTitle\(idea\.title\); setFromIdea\(idea\.id\); \}\}>Use this idea/);
    assert.match(portal, /Ideas suggested by AI — examples to discuss with your adviser, not advice/);
    assert.match(bridgeRoute, /requireCommandPrincipal\(request, "srs\.gap\.bridge"\)/);
  });
});

describe("the readiness report", () => {
  it("draws its sections from the template, and nothing else", () => {
    assert.match(reportDocument, /template\.sections\.map\(\(section\) =>/);
    assert.match(reportDocument, /switch \(section\.kind\)/);
    assert.doesNotMatch(reportDocument, /evidence\?*\.note|\.owner\b|dueDate/, "no note, owner or due date is drawn");
    assert.match(reportDocument, /Until then there is deliberately no figure here/, "a truthful Future");
  });

  it("prints as pages: each section starts one, and nothing is fixed over the content", () => {
    const css = read("app/clients/[clientId]/srs-report/srs-report.css");
    assert.match(css, /@page\{size:A4/);
    assert.match(css, /\.nzsr-section\{break-before:page/);
    // Found in the S3 screenshots: a fixed footer printed over the radar on every page.
    assert.doesNotMatch(css, /position:fixed/);
  });

  it("records the export before printing, and prints nothing if that is refused", () => {
    const exportAt = reportPrint.indexOf("/report-export");
    const printAt = reportPrint.indexOf("window.print()");
    assert.ok(exportAt > -1 && printAt > exportAt, "export, then print");
    assert.match(reportPrint, /if \(result\.state !== "success"\) \{ setError\([^]*?\); return; \}\s*window\.print\(\);/);
  });

  it("is read under srs.manage on the client, through the gated read model", () => {
    assert.match(reportRoute, /getSrsReport\(db, principal, \{ clientId,/);
    assert.match(reportPage, /loadScreen<SrsReportReadModel>\("srsReport"/);
  });
});
