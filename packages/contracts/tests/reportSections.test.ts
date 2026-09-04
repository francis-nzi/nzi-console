import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  crpReportSectionCatalogue,
  crpReportSectionTemplate,
  isCrpReportSectionKey,
  resolveReportSections,
  validateCommand,
} from "../src/index";

const context = {
  organisationId: "org-a",
  actorId: "staff-a",
  principal: "staff" as const,
  idempotencyKey: "k",
  correlationId: "c",
};

describe("CRP report section catalogue (NZC-048)", () => {
  it("has unique keys, ascending distinct ordinals and safe default HTML", () => {
    const keys = new Set(crpReportSectionCatalogue.map((s) => s.key));
    assert.equal(keys.size, crpReportSectionCatalogue.length);
    const ordinals = crpReportSectionCatalogue.map((s) => s.ordinal);
    assert.deepEqual(ordinals, [...ordinals].sort((a, b) => a - b));
    assert.equal(new Set(ordinals).size, ordinals.length);
    for (const section of crpReportSectionCatalogue) {
      assert.ok(section.title.trim().length > 0, section.key);
      assert.match(section.defaultBodyHtml, /^<(p|ul)>/);
      assert.doesNotMatch(section.defaultBodyHtml, /<script|onclick|javascript:/i);
    }
  });

  it("resolves an untouched report to the template set at version 0", () => {
    const resolved = resolveReportSections([]);
    assert.equal(resolved.length, crpReportSectionCatalogue.length);
    assert.deepEqual(
      resolved.map((s) => s.key),
      [...crpReportSectionCatalogue].sort((a, b) => a.ordinal - b.ordinal).map((s) => s.key),
    );
    for (const section of resolved) {
      assert.equal(section.contentSource, "default");
      assert.equal(section.version, 0);
      assert.equal(section.updatedBy, null);
      assert.equal(section.bodyHtml, crpReportSectionTemplate(section.key)!.defaultBodyHtml);
    }
  });

  it("overlays working rows and keeps report order", () => {
    const resolved = resolveReportSections([
      { key: "background", contentSource: "client-edited", bodyHtml: "<p>Bespoke background.</p>", version: 3, updatedBy: "staff-a", updatedAt: "2026-09-04T00:00:00.000Z" },
    ]);
    const background = resolved.find((s) => s.key === "background")!;
    assert.equal(background.contentSource, "client-edited");
    assert.equal(background.version, 3);
    assert.equal(background.bodyHtml, "<p>Bespoke background.</p>");
    // the rest are still template
    assert.equal(resolved.find((s) => s.key === "executive-summary")!.version, 0);
  });

  it("knows its own keys", () => {
    assert.equal(isCrpReportSectionKey("executive-summary"), true);
    assert.equal(isCrpReportSectionKey("no-such-section"), false);
  });
});

describe("report.section command validation", () => {
  it("rejects an unknown section, empty body and negative version", () => {
    const issues = validateCommand("report.section.edit", { jobId: "job-a", sectionKey: "nope", bodyHtml: "  ", expectedVersion: -1 }, context);
    assert.ok(issues.some((i) => i.field === "sectionKey" && i.code === "INVALID"));
    assert.ok(issues.some((i) => i.field === "bodyHtml"));
    assert.ok(issues.some((i) => i.field === "expectedVersion"));
  });

  it("rejects scripts and event handlers in the body", () => {
    const issues = validateCommand("report.section.edit", { jobId: "job-a", sectionKey: "background", bodyHtml: "<p onclick=\"x()\">hi</p>", expectedVersion: 0 }, context);
    assert.ok(issues.some((i) => i.field === "bodyHtml" && i.code === "UNSAFE"));
  });

  it("accepts a clean edit and a reset", () => {
    assert.deepEqual(validateCommand("report.section.edit", { jobId: "job-a", sectionKey: "background", bodyHtml: "<p>Fine.</p>", expectedVersion: 0 }, context), []);
    assert.deepEqual(validateCommand("report.section.reset", { jobId: "job-a", sectionKey: "background", expectedVersion: 2 }, context), []);
  });
});
