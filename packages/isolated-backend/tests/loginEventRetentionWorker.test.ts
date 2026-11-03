import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * The login-event retention tick is wired into the existing reminder worker, not a service of its own (the behaviour against a real
 * database is in `portalAccessEnforcementReal`). Source-level, because the worker is a script that opens its own connection.
 */
const here = dirname(fileURLToPath(import.meta.url));
const worker = readFileSync(resolve(here, "../scripts/reminder-worker.ts"), "utf8");
const render = readFileSync(resolve(here, "../../../render.yaml"), "utf8");

describe("login-event retention in the reminder worker", () => {
  it("runs once per London day, ahead of the rest of the tick, for the worker's organisation and each email-drain organisation", () => {
    assert.match(worker, /runLoginEventRetention\(pool, \[organisationId, \.\.\.emailOrganisations\]\)/);
    assert.match(worker, /if \(retentionDay !== day\)/);
    assert.match(worker, /if \(runs\.every\(\(run\) => run\.ok\)\) retentionDay = day;/, "a failed organisation is retried on the next tick, not skipped for the day");
    assert.ok(worker.indexOf("runLoginEventRetention(pool") < worker.indexOf("await runWorkerTick("), "retention is its own step ahead of the email and reminder parts");
  });

  it("logs one line per organisation per run - counts and ids, never network data", () => {
    assert.match(worker, /log\("login-events\.retention", run\.ok \? \{ organisationId: run\.organisationId, purged: run\.purged, cutoff: run\.cutoff \}/);
    assert.doesNotMatch(worker.slice(worker.indexOf("login-events.retention") - 200, worker.indexOf("login-events.retention") + 400), /\b(ip|user_agent|userAgent)\b/);
  });

  it("adds no Render service: the one worker, the one schedule", () => {
    assert.equal((render.match(/^\s*- type: worker$/gm) ?? []).length, 1);
    assert.equal((render.match(/name: nzi-console-reminders/g) ?? []).length, 1);
    assert.doesNotMatch(render, /retention|cron/i);
  });
});
