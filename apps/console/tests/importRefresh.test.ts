import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { AuthorizationError, CommandValidationError, createV7ImportViewPool, v7ImportFastPathBlockers, type StaffPrincipal } from "@nzi/isolated-backend";
import type { V7ImportRefreshPreview } from "@nzi/contracts";
import { handleImportRefresh, IMPORT_SOURCE_UNAVAILABLE, type ImportRefreshDeps } from "../app/lib/importRefreshHandler";
import { CROSSWALK_PLAN_PATH, findCrosswalkPlanDirectory, importRefreshPlanOptions, PlanDirectoryMissing } from "../app/lib/importRefreshPlan";

/**
 * The import, server-side — Phase C (BRIEF-v7-import-server-side-phase-c): `import.refresh` made operable from the console. The
 * command's own guards — the fingerprints (SUMMARY_MOVED / DECISIONS_MOVED), the reason, the Admin gate, D7, the setter's access
 * and audit — are proven against real Postgres in v7ReingestRevertReal (Phase B). This proves what Phase C adds: the route's
 * order and its fail-closed source, the committed plan passed explicitly, and what the job's panel shows.
 */
(globalThis as { React?: unknown }).React = React;
// The view (and the labels it reuses) is loaded after React is global: the classic JSX transform needs it in scope.
let view: typeof import("../app/jobs/importRefreshView");
before(async () => { view = await import("../app/jobs/importRefreshView"); });
const read = (path: string) => readFileSync(new URL(`../app/${path}`, import.meta.url), "utf8");

const PRINCIPAL = { organisationId: "org-a", userId: "staff-crm", role: "consultant", capabilities: [] } as unknown as StaffPrincipal;
const SHAS = { summarySha256: "a".repeat(64), decisionsSha256: "b".repeat(64) };
const PREVIEW_BASE: V7ImportRefreshPreview = {
  mode: "preview", jobId: "job-1", legacyJobNumber: "J000901", outcome: "refused", ...SHAS,
  counts: { matched: 3, changed: 0, needsMapping: 0, new: 0, withdrawn: 0, linkedPairChanged: 0 }, verdict: "clean", exceptions: [],
  refusal: { stage: "ready", issues: [{ field: "jobId", code: "NOT_READY_TO_INGEST", message: "The job is clean, not ready to ingest." }] },
  chain: { resync: null, plan: null }, scopeTotals: null,
};

type Calls = { source: number; options: number; preview: unknown[]; commit: unknown[]; fastPath: unknown[]; failures: unknown[] };
const harness = (over: Partial<ImportRefreshDeps> = {}) => {
  const calls: Calls = { source: 0, options: 0, preview: [], commit: [], fastPath: [], failures: [] };
  const deps: ImportRefreshDeps = {
    principal: async () => PRINCIPAL,
    context: () => ({ organisationId: "org-a", actorId: "staff-crm", principal: "staff", idempotencyKey: "k", correlationId: "c", reason: "refresh it" }) as never,
    pool: () => ({}) as never,
    source: () => { calls.source += 1; return async () => ({ sourceSha256: "e".repeat(64), rows: [] }); },
    options: async () => { calls.options += 1; return { basePlan: { jobId: "job-1", crosswalkVersion: "none", crosswalkSha256: "0".repeat(64), vintageDatasetIds: [], rows: [] } }; },
    preview: (async (...args: unknown[]) => { calls.preview.push(args); return PREVIEW_BASE; }) as never,
    commit: (async (...args: unknown[]) => { calls.commit.push(args); return { data: { mode: "commit", ingestId: "i" }, auditEventId: "a", correlationId: "c", replayed: false }; }) as never,
    fastPath: (async (...args: unknown[]) => { calls.fastPath.push(args); return { fastPath: "deliberate", preview: PREVIEW_BASE, because: ["flagged"], flagged: 0 }; }) as never,
    success: (outcome) => Response.json({ data: outcome.data }, { status: 201 }),
    failure: (error) => { calls.failures.push(error); return Response.json({ code: "FAILED" }, { status: error instanceof AuthorizationError ? 403 : error instanceof CommandValidationError ? 422 : 500 }); },
    log: () => undefined,
    ...over,
  };
  return { deps, calls };
};
const post = (body: unknown) => new Request("http://localhost/api/isolated/jobs/job-1/import-refresh", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("the refresh route: who, which job, a fail-closed source, then the command", () => {
  it("a caller who may not refresh is refused first — the source is never touched", async () => {
    const { deps, calls } = harness({ principal: async () => { throw new AuthorizationError("import.refresh"); } });
    const response = await handleImportRefresh(post({ mode: "preview" }), "job-1", deps);
    assert.equal(response.status, 403);
    assert.deepEqual([calls.source, calls.options, calls.preview.length, calls.commit.length], [0, 0, 0, 0]);
  });
  it("fails closed with no NZI_V7_VIEW_URL — the real guard refuses before any connection, and no command runs", async () => {
    const { deps, calls } = harness({ source: () => { createV7ImportViewPool({}); throw new Error("unreachable"); } });
    const response = await handleImportRefresh(post({ mode: "preview" }), "job-1", deps);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: "IMPORT_SOURCE_UNAVAILABLE", message: IMPORT_SOURCE_UNAVAILABLE });
    assert.deepEqual([calls.preview.length, calls.commit.length], [0, 0]);
  });
  it("fails closed when the URL names the console's own Supabase project — the project-ref guard stays in force", async () => {
    const own = "postgresql://cc_import_view.consoleref000000000b:x@aws-0-eu-west-2.pooler.supabase.com:5432/postgres";
    const { deps, calls } = harness({ source: () => { createV7ImportViewPool({ NZI_V7_VIEW_URL: own, NZI_V7_VIEW_CA_CERT: "-----BEGIN CERTIFICATE-----x",
      NZI_ISOLATED_DATABASE_URL: own.replace("cc_import_view.", "postgres.") }); throw new Error("unreachable"); } });
    assert.equal((await handleImportRefresh(post({ mode: "commit", ...SHAS }), "job-1", deps)).status, 503);
    assert.equal(calls.commit.length, 0);
  });
  it("fails closed when the committed plans cannot be found — never an empty plan", async () => {
    const { deps, calls } = harness({ options: async () => { throw new PlanDirectoryMissing(); } });
    assert.equal((await handleImportRefresh(post({ mode: "preview" }), "job-1", deps)).status, 503);
    assert.equal(calls.preview.length, 0);
  });
  it("the job is the path's: a body naming another job is refused, never re-pointed", async () => {
    const { deps, calls } = harness();
    const response = await handleImportRefresh(post({ mode: "commit", jobId: "job-2", ...SHAS }), "job-1", deps);
    assert.equal(response.status, 422);
    assert.equal(((await response.json()) as { issues: Array<{ code: string }> }).issues[0]!.code, "JOB_MISMATCH");
    assert.deepEqual([calls.source, calls.commit.length], [0, 0]);
  });
  it("a preview runs the preview with the live source and the explicit plan, and returns it as the reply", async () => {
    const { deps, calls } = harness();
    const response = await handleImportRefresh(post({ mode: "preview" }), "job-1", deps);
    assert.equal(response.status, 200);
    assert.deepEqual(((await response.json()) as { data: unknown }).data, PREVIEW_BASE);
    const [, source, input, , options] = calls.preview[0] as [unknown, unknown, unknown, unknown, { basePlan?: unknown }];
    assert.equal(typeof source, "function");
    assert.deepEqual(input, { mode: "preview", jobId: "job-1" });
    assert.ok(options.basePlan, "the plan is passed explicitly, not left to import.meta.url");
    assert.equal(calls.commit.length, 0);
  });
  it("a commit runs the commit with the preview's fingerprints; its refusals — moved, the Admin gate — are the command's, answered as such", async () => {
    const { deps, calls } = harness();
    assert.equal((await handleImportRefresh(post({ mode: "commit", ...SHAS }), "job-1", deps)).status, 201);
    assert.deepEqual((calls.commit[0] as unknown[])[2], { mode: "commit", ...SHAS, jobId: "job-1" });
    const moved = harness({ commit: (async () => { throw new CommandValidationError([{ field: "summarySha256", code: "SUMMARY_MOVED", message: "The job's rows have moved since the preview; preview again." }]); }) as never });
    assert.equal((await handleImportRefresh(post({ mode: "commit", ...SHAS }), "job-1", moved.deps)).status, 422);
    assert.deepEqual((moved.calls.failures[0] as CommandValidationError).issues.map((issue) => issue.code), ["SUMMARY_MOVED"]);
    const gated = harness({ commit: (async () => { throw new AuthorizationError("import.refresh", "This organisation requires an Admin to commit a refresh."); }) as never });
    assert.equal((await handleImportRefresh(post({ mode: "commit", ...SHAS }), "job-1", gated.deps)).status, 403);
  });
  it("after a bring-in, a drift check of the job (Datasets Part 2, increment 2): after a commit and after the fast path's — never on a replay, a preview or a refusal", async () => {
    const checked: Array<[string, string]> = [];
    const afterBringIn = async (_principal: unknown, jobId: string, correlationId: string) => { checked.push([jobId, correlationId]); };
    await handleImportRefresh(post({ mode: "commit", ...SHAS }), "job-1", harness({ afterBringIn }).deps);
    assert.deepEqual(checked, [["job-1", "c"]]);
    await handleImportRefresh(post({ mode: "commit", ...SHAS }), "job-1", harness({ afterBringIn,
      commit: (async () => ({ data: { mode: "commit" }, auditEventId: "a", correlationId: "c", replayed: true })) as never }).deps);
    await handleImportRefresh(post({ mode: "preview" }), "job-1", harness({ afterBringIn }).deps);
    await handleImportRefresh(post({ mode: "auto" }), "job-1", harness({ afterBringIn }).deps);
    await handleImportRefresh(post({ mode: "commit", ...SHAS }), "job-1", harness({ afterBringIn,
      commit: (async () => { throw new CommandValidationError([{ field: "jobId", code: "SPANS_TWO_DATASET_YEARS", message: "x" }]); }) as never }).deps);
    assert.deepEqual(checked, [["job-1", "c"]], "a replay, a preview, a deliberate fast path and a refusal bring nothing in");
    await handleImportRefresh(post({ mode: "auto" }), "job-1", harness({ afterBringIn,
      fastPath: (async () => ({ fastPath: "refreshed", preview: PREVIEW_BASE, committed: {}, auditEventId: "a", correlationId: "fp", replayed: false })) as never }).deps);
    assert.deepEqual(checked, [["job-1", "c"], ["job-1", "fp"]]);
  });
});

describe("Phase D: the fast path is one action at the route, over the unchanged command", () => {
  const READY: V7ImportRefreshPreview = { ...PREVIEW_BASE, outcome: "would-commit", verdict: "ready-to-ingest", refusal: null,
    chain: { resync: { unchanged: 2, superseded: 1, added: 0, withdrawn: 0 }, plan: { committed: 3, decided: 0 } },
    scopeTotals: { "1": { v7Tco2e: 2.43, liveTco2e: 2.43 }, "2": { v7Tco2e: 0, liveTco2e: 0 }, "3": { v7Tco2e: 0.0015, liveTco2e: 0.0015 } } };
  const COMMITTED = { mode: "commit" as const, jobId: "job-1", ingestId: "i", sessionId: "s", resyncRunId: "rs", reingestRunId: "ri",
    resync: { unchanged: 2, superseded: 1, added: 0, withdrawn: 0 }, plan: { committed: 3, decided: 0 } };

  it("`auto` runs the fast path with the live source, the explicit plan and the caller's context — neither the preview nor the commit directly", async () => {
    const { deps, calls } = harness();
    const response = await handleImportRefresh(post({ mode: "auto" }), "job-1", deps);
    assert.equal(response.status, 200);
    const [, source, jobId, context, options] = calls.fastPath[0] as [unknown, unknown, string, { actorId: string }, { basePlan?: unknown }];
    assert.deepEqual([typeof source, jobId, context.actorId, Boolean(options.basePlan)], ["function", "job-1", "staff-crm", true]);
    assert.deepEqual([calls.preview.length, calls.commit.length], [0, 0]);
  });
  it("`auto` keeps the route's order: a refused caller and a refused source stop it before it runs; extra keys are refused", async () => {
    const refused = harness({ principal: async () => { throw new AuthorizationError("import.refresh"); } });
    assert.equal((await handleImportRefresh(post({ mode: "auto" }), "job-1", refused.deps)).status, 403);
    const closed = harness({ source: () => { createV7ImportViewPool({}); throw new Error("unreachable"); } });
    assert.equal((await handleImportRefresh(post({ mode: "auto" }), "job-1", closed.deps)).status, 503);
    const extra = harness();
    const response = await handleImportRefresh(post({ mode: "auto", ...SHAS }), "job-1", extra.deps);
    assert.equal(response.status, 422);
    assert.deepEqual([refused.calls.fastPath.length, closed.calls.fastPath.length, extra.calls.fastPath.length], [0, 0, 0]);
  });
  it("refreshed → 201 with the outcome and its audit id; a refusal inside it (moved, D7, ineligible at commit) is answered as the command's", async () => {
    const { deps } = harness({ fastPath: (async () => ({ fastPath: "refreshed", preview: READY, committed: COMMITTED, auditEventId: "audit-1", correlationId: "c", replayed: false })) as never });
    const response = await handleImportRefresh(post({ mode: "auto" }), "job-1", deps);
    assert.equal(response.status, 201);
    const body = await response.json() as { data: { fastPath: string }; auditEventId: string };
    assert.deepEqual([body.data.fastPath, body.auditEventId], ["refreshed", "audit-1"]);
    const raced = harness({ fastPath: (async () => { throw new CommandValidationError([{ field: "jobId", code: "FAST_PATH_INELIGIBLE", message: "The job changed since its preview." }]); }) as never });
    assert.equal((await handleImportRefresh(post({ mode: "auto" }), "job-1", raced.deps)).status, 422);
  });
  it("the verdict: the three gates and the Admin gate, each alone, in the brief's order", () => {
    const clean = { issuedReport: false, manualEdits: false };
    assert.deepEqual(v7ImportFastPathBlockers(READY, clean, false), [], "eligible");
    assert.deepEqual(v7ImportFastPathBlockers(READY, { ...clean, issuedReport: true }, false), ["issued-report"]);
    assert.deepEqual(v7ImportFastPathBlockers(READY, { ...clean, manualEdits: true }, false), ["manual-edits"]);
    assert.deepEqual(v7ImportFastPathBlockers({ ...READY, exceptions: [{ legacyDbId: "1", status: "new", ownStatus: "new", resolution: "unresolved", carry: null, scope: "1", code: null, pairGroup: null }] }, clean, false), ["flagged"]);
    assert.deepEqual(v7ImportFastPathBlockers({ ...READY, outcome: "refused", scopeTotals: null, refusal: { stage: "reingest", issues: [] } }, clean, false), ["flagged"], "D7 refusing is flagged");
    assert.deepEqual(v7ImportFastPathBlockers(READY, clean, true), ["admin-commits"]);
  });
  it("the modal says why a refresh was not automatic, in one line — and a clean job just has nothing to refresh", () => {
    assert.equal(COMMITTED.mode, "commit");
    const line = (because: Array<"issued-report" | "manual-edits" | "flagged" | "admin-commits">, flagged = 0, preview: V7ImportRefreshPreview = READY) =>
      view.notAutomaticLine({ fastPath: "deliberate", preview, because, flagged });
    assert.equal(line(["issued-report"]), "Not automatic: issued report.");
    assert.equal(line(["manual-edits", "flagged"], 3, { ...PREVIEW_BASE, verdict: "needs-mapping" }), "Not automatic: manual edits · 3 flagged.");
    assert.equal(line(["admin-commits"]), "Not automatic: an Admin commits on this organisation.");
    assert.equal(line(["flagged"], 0, PREVIEW_BASE), null, "a clean job: Nothing to refresh, no reason to give");
  });
  it("the modal's bring-in is one action, `auto`; its commit, on a fallback, is still Phase C's", () => {
    // BRIEF-v7-import-rows-modal: the job's one action moved from the panel into the import rows modal's "Accept & bring in".
    const modal = read("jobs/ImportRowsModal.tsx");
    assert.match(modal, /postBrowserCommand<FastPathOutcome>\(path, \{ mode: "auto" \}/);
    assert.ok(!/mode: "preview"/.test(modal), "the modal never previews without the fast path");
    assert.ok(!/mode: "auto"|mode: "commit"/.test(read("jobs/ImportRefreshPanel.tsx")), "the panel only opens the modal");
    assert.match(read("api/isolated/jobs/[jobId]/import-refresh/route.ts"), /fastPath: refreshV7ImportFastPath/);
  });
});

describe("the committed plan, passed explicitly from a known server location", () => {
  it("is found upward from the service's working directory — apps/console, as `npm run start -w` runs it", () => {
    const dir = findCrosswalkPlanDirectory(fileURLToPath(new URL("..", import.meta.url)));
    assert.ok(dir.replace(/\\/g, "/").endsWith(CROSSWALK_PLAN_PATH.replace(/\\/g, "/")));
    const plan = importRefreshPlanOptions("v7-job-2", "J000002", () => dir).basePlan!;
    assert.equal(plan.jobId, "v7-job-2");
    assert.ok(plan.rows.length > 0, "the repository's plan for J000002, read whole");
    assert.throws(() => importRefreshPlanOptions("v7-job-999", "J000002", () => dir), (error: unknown) => error instanceof CommandValidationError
      && error.issues[0]!.code === "PLAN_OF_ANOTHER_JOB", "a plan of another job refuses");
  });
  it("refuses — never an empty plan — when there is no plan directory above the working directory", () => {
    assert.throws(() => findCrosswalkPlanDirectory(mkdtempSync(join(tmpdir(), "nzi-noplan-")), () => false), PlanDirectoryMissing);
  });
  it("the route passes it, rather than the backend's default (the build machine's path, baked into the bundle)", () => {
    const route = read("api/isolated/jobs/[jobId]/import-refresh/route.ts");
    assert.match(route, /importRefreshPlanOptions\(id,/);
    assert.match(route, /source: \(\) => liveImportViewSource\(\)/);
    // BRIEF-v7-import-rows-modal §B: from the job, a commit is refused unless every scope agrees to one decimal place.
    assert.match(route, /requireScopesAgree: true,/);
    // BRIEF-v7-import-j000663 §B: from the job, a person may bring in on a snapshotted job (the batch's route never does).
    assert.match(route, /allowSnapshotted: true,/);
    // Datasets Part 2, increment 2: the previous system's own row figures for a spanning job, and a drift check after each bring-in.
    assert.match(route, /rowFigures: liveRowFiguresClient\(\) \}\)/);
    assert.match(route, /afterBringIn: checkAfterBringIn,/);
    assert.match(read("api/isolated/jobs/[jobId]/import-refresh/rows/route.ts"), /rowFigures: liveRowFiguresClient\(\) \}\)/);
  });
});

describe("what one preview means (the modal shows it in its reconcile strip and footer)", () => {
  it("a clean job is nothing to refresh — not an error, not a refusal", () => {
    assert.deepEqual(view.refreshViewOf(PREVIEW_BASE), { kind: "nothing" });
    assert.equal(view.NOTHING_TO_REFRESH, "Nothing to refresh");
  });
  it("a job with exceptions is exceptions — the rows that still need a person", () => {
    const preview: V7ImportRefreshPreview = { ...PREVIEW_BASE, verdict: "needs-mapping",
      counts: { matched: 5, changed: 2, needsMapping: 0, new: 1, withdrawn: 1, linkedPairChanged: 0 },
      exceptions: [
        { legacyDbId: "1004", status: "new", ownStatus: "new", resolution: "unresolved", carry: null, scope: "1", code: "7_400_4000_5_1", pairGroup: null },
        { legacyDbId: "1003", status: "withdrawn", ownStatus: "withdrawn", resolution: "stale", carry: null, scope: "1", code: null, pairGroup: null },
      ],
      refusal: { stage: "ready", issues: [{ field: "jobId", code: "NOT_READY_TO_INGEST", message: "The job is needs-mapping, not ready to ingest." }] } };
    const seen = view.refreshViewOf(preview);
    assert.equal(seen.kind, "exceptions");
    assert.deepEqual(seen.kind === "exceptions" ? seen.exceptions.map((row) => row.legacyDbId) : [], ["1004", "1003"], "exactly the exceptions");
  });
  it("a preview that would commit is ready: the previous system's total against the live total, per scope", () => {
    const preview: V7ImportRefreshPreview = { ...PREVIEW_BASE, outcome: "would-commit", verdict: "ready-to-ingest", refusal: null,
      chain: { resync: { unchanged: 1, superseded: 1, added: 1, withdrawn: 1 }, plan: { committed: 2, decided: 1 } },
      scopeTotals: { "1": { v7Tco2e: 0.34, liveTco2e: 0.34 }, "2": { v7Tco2e: 0, liveTco2e: 0 }, "3": { v7Tco2e: 0.0015, liveTco2e: 0.0015 } } };
    assert.deepEqual(view.refreshViewOf(preview), { kind: "ready", totals: [{ scope: "1", previous: 0.34, live: 0.34 }, { scope: "2", previous: 0, live: 0 }, { scope: "3", previous: 0.0015, live: 0.0015 }] });
  });
  it("a refused preview (D7) is refused: the step and its codes", () => {
    const preview: V7ImportRefreshPreview = { ...PREVIEW_BASE, verdict: "ready-to-ingest",
      refusal: { stage: "reingest", issues: [{ field: "rows", code: "PLAN_UNIT_MISMATCH", message: "A row's unit does not match its factor." }] },
      chain: { resync: { unchanged: 1, superseded: 1, added: 1, withdrawn: 1 }, plan: { committed: 2, decided: 1 } } };
    assert.deepEqual(view.refreshViewOf(preview), { kind: "refused", stage: "reingest", issues: [{ code: "PLAN_UNIT_MISMATCH", message: "A row's unit does not match its factor." }] });
  });
});

describe("the wiring", () => {
  it("the refresh route is import.refresh — the command's principal for both modes, the capability for the panel's read", () => {
    const route = read("api/isolated/jobs/[jobId]/import-refresh/route.ts");
    assert.match(route, /requireCommandPrincipal\(req, "import\.refresh"\)/);
    assert.match(route, /requireCapability\(principal, "import\.refresh"\)/);
    assert.ok(!/export async function (PUT|PATCH|DELETE)/.test(route), "GET and POST only");
  });
  it("the policy setter is its governed command (admin.settings, a reason); its read fails closed", () => {
    const route = read("api/isolated/organisation/import-policy/route.ts");
    assert.match(route, /requireCommandPrincipal\(request, "organisation\.importPolicy\.set"\)/);
    assert.match(route, /setOrganisationImportPolicy\(isolatedPool\(\), body, commandContext\(request, principal\)\)/);
    assert.match(route, /readImportPolicy\(db/);
    assert.ok(!/readImportPolicySafely|refreshCommitRequiresAdmin: false/.test(route), "an unreadable policy is an error, never 'off'");
  });
  it("storing a summary to resolve is the existing upload, import.manage — the modal stores it before a decision, and commits with the preview's fingerprints", () => {
    const route = read("api/isolated/jobs/[jobId]/import-refresh/summary/route.ts");
    assert.match(route, /requireCommandPrincipal\(request, "import\.summary\.upload"\)/);
    assert.match(route, /uploadV7ImportSummary\(isolatedPool\(\)/);
    const modal = read("jobs/ImportRowsModal.tsx");
    assert.match(modal, /if \(data\.summaryCurrent\) return true;\s*const stored = await postBrowserCommand\(`\$\{path\}\/summary`/);
    assert.match(modal, /postBrowserCommandWithReason<V7ImportRefreshCommitted>\(path,\s*\{ mode: "commit", summarySha256: preview\.summarySha256, decisionsSha256: preview\.decisionsSha256 \}/);
    assert.ok(!/\/admin\/import/.test(read("jobs/ImportRefreshPanel.tsx") + modal), "no bounce to Import reconciliation");
  });
  it("the panel is on every job page, beside Milestones and Time", () => {
    assert.match(read("jobs/[jobId]/page.tsx"), /<ImportRefreshPanel jobId=\{job\.header\.id\} \/>/);
  });
  it("and under the job shell too: the shell renders none of the page's panels, so it is handed the refresh panel by name and shows it", () => {
    // FINDING-import-refresh-panel-not-rendering (23 Nov): with `job-shell` on, the CRP page rendered only the shell's named
    // panels — the refresh panel was in `panels` alone, so an imported job had no Refresh from the previous system.
    const page = read("jobs/[jobId]/page.tsx");
    assert.match(page, /const panels = <>\{datesPanel \? <section className="nz-body">\{datesPanel\}<\/section> : null\}\{milestones\}\{timePanel\}\{importPanel\}<\/>;/);
    assert.match(page, /const shell = \{ milestonesPanel: milestones, datesPanel, baselineYearJob: [^,]+, timePanel: shellTimePanel, importPanel, milestoneStates \};/);
    const workspace = read("jobs/CrpScopeWorkspace.tsx");
    assert.match(workspace, /importPanel\?: ReactNode/);
    assert.match(workspace, /<div className="nz-body nz-shell-body">\s*\{noticeBanner\}\s*\{shell\?\.importPanel \?\? null\}/);
  });
  it("the batch's review queue links each job to its page — where the panel is", () => {
    assert.ok(read("clients/[clientId]/importBatchView.tsx").includes("href={`/jobs/${encodeURIComponent(item.jobId)}`}"));
  });
});
