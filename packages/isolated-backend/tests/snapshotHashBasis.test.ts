import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { resolveReportSections } from "@nzi/contracts";
import { snapshotHashBasis } from "../src/postgresCommands";

/**
 * B2-4 (RULING-report-studio-B2-4 (c)): the evidence hash seals the reviewed figures and their provenance, not editable boilerplate.
 * Adopting composed@5's wording as the catalogue default must not move the seal of a snapshot whose evidence is the same.
 */
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
const hash = <T extends Parameters<typeof snapshotHashBasis>[0]>(payload: T) => createHash("sha256").update(JSON.stringify(stable(snapshotHashBasis(payload)))).digest("hex");
const payload = (sections: ReturnType<typeof resolveReportSections>) => ({ jobId: "job-a", reportingYear: 2025, measurements: [{ rowId: "r", scope: "1", tco2e: 10 }], sections });

describe("the reviewed snapshot's evidence hash basis", () => {
  it("does not move when only an unedited section's template wording (or title, or place) changes", () => {
    const today = resolveReportSections([]);
    const reworded = today.map((section) => ({ ...section, title: `${section.title} (renamed)`, ordinal: section.ordinal + 5, bodyHtml: `<p>Different template wording for ${section.key}.</p>` }));
    assert.equal(hash(payload(today)), hash(payload(reworded)));
  });

  it("still seals an edited section's own words — the job's text, not boilerplate", () => {
    const edited = (body: string) => resolveReportSections([{ key: "executive-summary", contentSource: "client-edited", bodyHtml: body, version: 2, updatedBy: "ada", updatedAt: "2026-10-19T00:00:00.000Z" }]);
    assert.notEqual(hash(payload(edited("<p>One wording.</p>"))), hash(payload(edited("<p>Another wording.</p>"))));
  });

  it("still seals the evidence — a changed figure moves the hash", () => {
    const sections = resolveReportSections([]);
    assert.notEqual(hash(payload(sections)), hash({ ...payload(sections), measurements: [{ rowId: "r", scope: "1", tco2e: 11 }] }));
  });

  it("is a basis only: the stored payload keeps every section's text", () => {
    const stored = payload(resolveReportSections([]));
    const basis = snapshotHashBasis(stored);
    assert.ok(stored.sections.every((section) => section.bodyHtml.length > 0 && section.title.length > 0), "the payload is unchanged");
    assert.deepEqual(basis.sections, stored.sections.map((section) => ({ key: section.key, version: 0 })));
  });
});
