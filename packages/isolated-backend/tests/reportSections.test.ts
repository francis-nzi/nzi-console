import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crpReportSectionTemplate, crpReportSectionCatalogue } from "@nzi/contracts";
import { CommandValidationError, VersionConflictError, editReportSection, regenerateReportSection, resetReportSection } from "../src/index";

const context = { organisationId: "org-a", actorId: "staff-a", principal: "staff" as const, idempotencyKey: "sec-1", correlationId: "corr-sec-1" };

/** Mock pool that answers the SQL `editReportSection` / `resetReportSection` issue. */
function sectionPool(opts: { jobFamily?: string; currentVersion?: number } = {}) {
  const writes: Array<{ sql: string; values: readonly unknown[] }> = [];
  let auditCount = 0;
  let outboxCount = 0;
  let stored: { request_hash: string; outcome_json: Record<string, unknown> } | undefined;
  const client = {
    async query(sql: string, values: readonly unknown[] = []) {
      if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: stored ? [stored] : [] };
      if (sql.includes("SELECT job_family FROM nzi_console.jobs")) return { rows: opts.jobFamily === undefined ? [{ job_family: "crp" }] : opts.jobFamily === null ? [] : [{ job_family: opts.jobFamily }] };
      if (sql.includes("SELECT version FROM nzi_console.report_sections")) return { rows: opts.currentVersion ? [{ version: opts.currentVersion }] : [] };
      if (sql.startsWith("INSERT INTO nzi_console.report_sections") || sql.startsWith("UPDATE nzi_console.report_sections") || sql.startsWith("INSERT INTO nzi_console.report_section_versions")) writes.push({ sql, values });
      if (sql.includes("INSERT INTO nzi_console.audit_events")) auditCount += 1;
      if (sql.includes("INSERT INTO nzi_console.transactional_outbox")) outboxCount += 1;
      if (sql.includes("INSERT INTO nzi_console.command_idempotency")) stored = { request_hash: String(values[3]), outcome_json: JSON.parse(String(values[4])) as Record<string, unknown> };
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as never, writes, metrics: () => ({ auditCount, outboxCount }) };
}

describe("report section commands (NZC-048)", () => {
  it("first edit inserts a working row at version 1, content-source client-edited, and appends history", async () => {
    const state = sectionPool();
    const result = await editReportSection(state.pool, { jobId: "job-a", sectionKey: "background", bodyHtml: "<p>Bespoke.</p>", expectedVersion: 0 }, context);
    assert.equal(result.data.version, 1);
    assert.equal(result.data.contentSource, "client-edited");
    assert.ok(state.writes.some((w) => w.sql.startsWith("INSERT INTO nzi_console.report_sections") && w.values.includes("<p>Bespoke.</p>")));
    assert.ok(state.writes.some((w) => w.sql.startsWith("INSERT INTO nzi_console.report_section_versions")));
    assert.deepEqual(state.metrics(), { auditCount: 1, outboxCount: 1 });
  });

  it("a subsequent edit updates the row and bumps the version", async () => {
    const state = sectionPool({ currentVersion: 3 });
    const result = await editReportSection(state.pool, { jobId: "job-a", sectionKey: "background", bodyHtml: "<p>v4.</p>", expectedVersion: 3 }, context);
    assert.equal(result.data.version, 4);
    assert.ok(state.writes.some((w) => w.sql.startsWith("UPDATE nzi_console.report_sections")));
  });

  it("an AI redraft records content-source ai", async () => {
    const state = sectionPool();
    const result = await editReportSection(state.pool, { jobId: "job-a", sectionKey: "background", bodyHtml: "<p>AI.</p>", expectedVersion: 0, contentSource: "ai" }, context);
    assert.equal(result.data.contentSource, "ai");
  });

  it("stale expectedVersion is a version conflict", async () => {
    const state = sectionPool({ currentVersion: 5 });
    await assert.rejects(
      () => editReportSection(state.pool, { jobId: "job-a", sectionKey: "background", bodyHtml: "<p>x.</p>", expectedVersion: 3 }, context),
      VersionConflictError,
    );
  });

  it("rejects a non-CRP job", async () => {
    const state = sectionPool({ jobFamily: "lca" });
    await assert.rejects(
      () => editReportSection(state.pool, { jobId: "job-a", sectionKey: "background", bodyHtml: "<p>x.</p>", expectedVersion: 0 }, context),
      CommandValidationError,
    );
  });

  it("reset with no working row is an idempotent no-op at version 0", async () => {
    const state = sectionPool();
    const result = await resetReportSection(state.pool, { jobId: "job-a", sectionKey: "background", expectedVersion: 0 }, context);
    assert.equal(result.data.version, 0);
    assert.equal(result.data.contentSource, "default");
    assert.ok(!state.writes.some((w) => w.sql.includes("report_sections") && !w.sql.includes("SELECT")));
  });

  it("regenerate writes the AI template variant with content-source ai and history", async () => {
    const state = sectionPool({ currentVersion: 1 });
    const result = await regenerateReportSection(state.pool, { jobId: "job-a", sectionKey: "executive-summary", expectedVersion: 1 }, context);
    assert.equal(result.data.version, 2);
    assert.equal(result.data.contentSource, "ai");
    const ai = crpReportSectionCatalogue.find((s) => s.key === "executive-summary")!.aiBodyHtml;
    assert.ok(state.writes.some((w) => w.sql.startsWith("UPDATE nzi_console.report_sections") && w.values.includes(ai)));
    assert.ok(state.writes.some((w) => w.sql.startsWith("INSERT INTO nzi_console.report_section_versions") && w.values.includes("ai")));
  });

  it("regenerate on an untouched section (v0) inserts the AI draft at v1", async () => {
    const state = sectionPool();
    const result = await regenerateReportSection(state.pool, { jobId: "job-a", sectionKey: "background", expectedVersion: 0 }, context);
    assert.equal(result.data.version, 1);
    assert.ok(state.writes.some((w) => w.sql.startsWith("INSERT INTO nzi_console.report_sections")));
  });

  it("regenerate with a stale version conflicts", async () => {
    const state = sectionPool({ currentVersion: 4 });
    await assert.rejects(
      () => regenerateReportSection(state.pool, { jobId: "job-a", sectionKey: "background", expectedVersion: 2 }, context),
      VersionConflictError,
    );
  });

  it("reset of an edited section restores the template body at a new version", async () => {
    const state = sectionPool({ currentVersion: 2 });
    const result = await resetReportSection(state.pool, { jobId: "job-a", sectionKey: "background", expectedVersion: 2 }, context);
    assert.equal(result.data.version, 3);
    assert.equal(result.data.contentSource, "default");
    const template = crpReportSectionTemplate("background")!.defaultBodyHtml;
    assert.ok(state.writes.some((w) => w.sql.startsWith("UPDATE nzi_console.report_sections") && w.values.includes(template)));
    assert.ok(state.writes.some((w) => w.sql.startsWith("INSERT INTO nzi_console.report_section_versions") && w.values.includes(template)));
  });
});
