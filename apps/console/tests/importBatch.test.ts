import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthorizationError, CommandValidationError, V7ImportViewConnectionRefused, type StaffPrincipal } from "@nzi/isolated-backend";
import type { CommandKey } from "@nzi/contracts";
import { handleImportBatch, type ImportBatchDeps } from "../app/lib/importBatchHandler";
import { IMPORT_SOURCE_UNAVAILABLE } from "../app/lib/importRefreshHandler";
import { PlanDirectoryMissing } from "../app/lib/importRefreshPlan";

/**
 * The import, server-side — Phase E (BRIEF-v7-import-server-side-phase-e): the batch from the console. The orchestration — which
 * jobs, the nets, the lease, resume, the Admin gate — is proven against real Postgres in v7ReingestRevertReal. This proves what the
 * console adds: the routes' order and fail-closed start, the runner started after the reply, and what the client's panel shows.
 */
(globalThis as { React?: unknown }).React = React;
let view: typeof import("../app/clients/[clientId]/importBatchView");
before(async () => { view = await import("../app/clients/[clientId]/importBatchView"); });
const read = (path: string) => readFileSync(new URL(`../app/${path}`, import.meta.url), "utf8");

const PRINCIPAL = { organisationId: "org-a", userId: "staff-admin", role: "admin", capabilities: [] } as unknown as StaffPrincipal;
const RUN = "v7-batch-00000000-0000-4000-8000-000000000000";
type Calls = { keys: CommandKey[]; ready: number; start: unknown[]; resume: unknown[]; kicked: Array<[string, string]>; order: string[] };
const harness = (over: Partial<ImportBatchDeps> = {}) => {
  const calls: Calls = { keys: [], ready: 0, start: [], resume: [], kicked: [], order: [] };
  const deps: ImportBatchDeps = {
    principal: async (_request, key) => { calls.keys.push(key); return PRINCIPAL; },
    context: () => ({ organisationId: "org-a", actorId: "staff-admin", principal: "staff", idempotencyKey: "k", correlationId: "c" }) as never,
    pool: () => ({}) as never,
    ready: () => { calls.ready += 1; },
    start: (async (...args: unknown[]) => { calls.start.push(args); calls.order.push("start"); return { data: { clientId: "c1", runId: RUN, jobs: 3 }, auditEventId: "a", correlationId: "c", replayed: false }; }) as never,
    resume: (async (...args: unknown[]) => { calls.resume.push(args); calls.order.push("resume"); return { data: { clientId: "c1", runId: RUN, remaining: 2 }, auditEventId: "a", correlationId: "c", replayed: false }; }) as never,
    kick: (organisationId, runId) => { calls.kicked.push([organisationId, runId]); calls.order.push("kick"); },
    success: (outcome) => Response.json({ data: outcome.data }, { status: 201 }),
    failure: (error) => Response.json({ code: "FAILED" }, { status: error instanceof AuthorizationError ? 403 : error instanceof CommandValidationError ? 422 : 500 }),
    log: () => undefined,
    ...over,
  };
  return { deps, calls };
};
const post = (body: unknown) => new Request("http://localhost/api/isolated/clients/c1/import-refresh-batch", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("the batch routes: who, which client, a fail-closed start, then the command and the runner", () => {
  it("a caller who may not run a batch is refused first — nothing is checked, started or run", async () => {
    const { deps, calls } = harness({ principal: async () => { throw new AuthorizationError("import.refresh_batch"); } });
    assert.equal((await handleImportBatch(post({}), "c1", "start", deps)).status, 403);
    assert.deepEqual([calls.ready, calls.start.length, calls.kicked.length], [0, 0, 0]);
  });
  it("start and resume each ask for their own command's capability", async () => {
    const { deps, calls } = harness();
    await handleImportBatch(post({}), "c1", "start", deps);
    await handleImportBatch(post({ runId: RUN }), "c1", "resume", deps);
    assert.deepEqual(calls.keys, ["import.refreshBatch.start", "import.refreshBatch.resume"]);
  });
  it("the client is the path's: a body naming another is refused, never re-pointed", async () => {
    const { deps, calls } = harness();
    const response = await handleImportBatch(post({ clientId: "c2" }), "c1", "start", deps);
    assert.equal(response.status, 422);
    assert.equal(((await response.json()) as { issues: Array<{ code: string }> }).issues[0]!.code, "CLIENT_MISMATCH");
    assert.equal(calls.start.length, 0);
  });
  it("no reachable source, or no committed plans: 503, and no run is started", async () => {
    for (const error of [new V7ImportViewConnectionRefused("unset"), new PlanDirectoryMissing()]) {
      const { deps, calls } = harness({ ready: () => { throw error; } });
      const response = await handleImportBatch(post({}), "c1", "start", deps);
      assert.equal(response.status, 503);
      assert.equal(((await response.json()) as { message: string }).message, IMPORT_SOURCE_UNAVAILABLE);
      assert.deepEqual([calls.start.length, calls.kicked.length], [0, 0]);
    }
  });
  it("the command first, then the runner for that run — the reply does not wait for the jobs", async () => {
    const { deps, calls } = harness();
    const response = await handleImportBatch(post({}), "c1", "start", deps);
    assert.equal(response.status, 201);
    assert.deepEqual(calls.order, ["start", "kick"]);
    assert.deepEqual((calls.start[0] as unknown[])[1], { clientId: "c1" });
    assert.deepEqual(calls.kicked, [["org-a", RUN]]);
    const resumed = harness();
    await handleImportBatch(post({ runId: RUN }), "c1", "resume", resumed.deps);
    assert.deepEqual([(resumed.calls.resume[0] as unknown[])[1], resumed.calls.order], [{ clientId: "c1", runId: RUN }, ["resume", "kick"]]);
  });
  it("a refused command starts no runner", async () => {
    const { deps, calls } = harness({ start: (async () => { throw new CommandValidationError([{ field: "clientId", code: "BATCH_OPEN", message: "open" }]); }) as never });
    assert.equal((await handleImportBatch(post({}), "c1", "start", deps)).status, 422);
    assert.equal(calls.kicked.length, 0);
  });
  it("is wired: the routes hand in the real start, resume and in-process runner; the client's Manage tab shows the panel", () => {
    const deps = read("lib/importBatchDeps.ts");
    for (const piece of ["start: startV7ImportBatch", "resume: resumeV7ImportBatch", "kick: kickImportBatch", "liveImportViewSource(); findCrosswalkPlanDirectory();"]) assert.ok(deps.includes(piece), piece);
    assert.ok(read("api/isolated/clients/[clientId]/import-refresh-batch/route.ts").includes(`requireCapability(principal, "import.refresh_batch")`));
    assert.ok(read("api/isolated/clients/[clientId]/import-refresh-batch/resume/route.ts").includes(`handleImportBatch(request, clientId, "resume", importBatchDeps)`));
    const runner = read("lib/importBatchRunner.ts");
    assert.ok(runner.includes("runV7ImportBatch(isolatedPool(), organisationId, runId"), "the backend runner, unchanged");
    assert.ok(read("clients/[clientId]/ClientWorkspaceView.tsx").includes("<ImportBatchPanel clientId={client.id} />"));
  });
});

describe("the client's batch panel", () => {
  const TALLY = { total: 6, refreshed: 1, exceptions: 3, failed: 1, current: 1, skipped: 0, pending: 0 };
  const QUEUE = [
    { jobId: "j2", jobNumber: "J009302", status: "queued" as const, because: ["manual-edits" as const], flagged: 0, refusalCodes: [], failureClass: null },
    { jobId: "j3", jobNumber: "J009303", status: "queued" as const, because: ["flagged" as const], flagged: 2, refusalCodes: [], failureClass: null },
    { jobId: "j5", jobNumber: "J009305", status: "failed" as const, because: [], flagged: 0, refusalCodes: [], failureClass: "view-timeout" as const },
    { jobId: "j6", jobNumber: "J009306", status: "refused" as const, because: [], flagged: 0, refusalCodes: ["SNAPSHOT_EXISTS"], failureClass: null },
  ];
  const run = (over: Record<string, unknown> = {}) => ({ runId: RUN, status: "completed" as const, createdAt: "2026-11-15T10:00:00.000Z", finishedAt: "2026-11-15T10:05:00.000Z", stopped: false, tally: TALLY, queue: QUEUE, ...over });
  const html = (props: ReturnType<typeof run>) => renderToStaticMarkup(createElement(view.ImportBatchRunView, { run: props as never }));

  it("the tally: total · refreshed · exceptions · failed, then what needed nothing", () => {
    assert.equal(view.tallyLine(TALLY), "6 jobs · 1 refreshed · 3 exceptions · 1 failed");
    assert.equal(view.restLine(TALLY), "1 no change");
    assert.equal(view.restLine({ ...TALLY, skipped: 2, pending: 3 }), "1 no change · 2 already current locally · 3 still to run");
  });
  it("the queue: each job that did not refresh, why in the fast path's own words, linking to its refresh panel", () => {
    const markup = html(run());
    for (const [jobId, line] of [["j2", "Not automatic: manual edits."], ["j3", "Not automatic: 2 flagged."], ["j5", "Failed: the previous system did not answer in time."],
      ["j6", "Refused: SNAPSHOT_EXISTS."]] as const) {
      assert.ok(markup.includes(`href="/jobs/${jobId}"`), jobId);
      assert.ok(markup.includes(line), line);
    }
    assert.ok(!/v7/i.test(markup.replace(/v7-batch-[0-9a-f-]+/g, "")), "no internal name on screen");
  });
  it("skipped reads as already current locally — not re-checked against the previous system", () => {
    const markup = html(run({ tally: { ...TALLY, skipped: 2 } }));
    assert.ok(markup.includes("2 already current locally"));
    assert.ok(markup.includes("were not read from the previous system again"));
  });
  it("running, stopped (Resume) and cancelled each say so; a finished run with nothing queued says nothing needs a person", () => {
    assert.ok(html(run({ status: "running", finishedAt: null })).includes("one job at a time"));
    assert.ok(html(run({ status: "running", finishedAt: null, stopped: true })).includes("Resume it"));
    assert.ok(html(run({ status: "cancelled" })).includes("may no longer run one"));
    assert.ok(html(run({ queue: [] })).includes("Nothing needs a person."));
  });
  it("paused by the breaker: says the previous system was not responding — not a restart — and offers Resume", () => {
    const markup = html(run({ status: "running", finishedAt: null, stopped: true, paused: "source-unresponsive" }));
    assert.ok(markup.includes(view.PAUSED_LINE));
    assert.equal(view.PAUSED_LINE, "Paused — the previous system was not responding.");
    assert.ok(!markup.includes("the service restarted"), "one reason, the right one");
    assert.ok(markup.includes("Resume it once the previous system is answering again"));
  });
  it("the runner's pause defaults to the 2s floor and cannot be set below it", () => {
    const runner = read("lib/importBatchRunner.ts");
    assert.ok(runner.includes("NZI_IMPORT_BATCH_PAUSE_MS ?? String(V7_IMPORT_BATCH_PACING.pauseMs)"));
    assert.ok(runner.includes("pauseMs >= V7_IMPORT_BATCH_PACING.pauseMs ? pauseMs : V7_IMPORT_BATCH_PACING.pauseMs"));
  });
});
