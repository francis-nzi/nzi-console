import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ADMIN_ITEMS } from "../app/admin/adminNav";

/**
 * SRS S1 in the console: the Admin SRS framework page (R1; Phase B — lock, unlock, history) and the client's SRS area dated
 * on completion (R3 — in progress vs assessed, completion held until every requirement is addressed, no date typed at
 * start, a reassessment that starts a new assessment).
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, "..", path), "utf8");
const page = read("app/admin/srs-framework/page.tsx");
const board = read("app/admin/srs-framework/SrsFrameworkBoard.tsx");
const area = read("app/clients/[clientId]/SrsArea.tsx");
const start = read("app/clients/[clientId]/SrsAssessmentForms.tsx");

describe("the Admin SRS framework (R1)", () => {
  it("is on the admin rail, live, under admin.lookups", () => {
    const item = ADMIN_ITEMS.find((entry) => entry.id === "srs-framework");
    assert.deepEqual([item?.href, item?.capability, item?.phase], ["/admin/srs-framework", "admin.lookups", undefined]);
  });

  it("reads each framework's lock, the snapshots, the history, the one in force and the working definition, and edits only with admin.lookups and writes on", () => {
    for (const call of ["listSrsFrameworkStates(db)", "listSrsFrameworkSnapshots(db)", "listSrsFrameworkHistory(db)", "getSrsFramework(db, workingId)"]) assert.ok(page.includes(call), call);
    assert.match(page, /holds\(access\.capabilities, "admin\.lookups"\)/);
  });

  it("edits only an unlocked framework: a locked one is read-only, pillars and the ladder wait for every framework, and unlocking warns first (Phase B)", () => {
    assert.match(board, /const unlockedKeys = new Set\(working && editing\.allowed \? frameworks\.filter\(\(framework\) => !framework\.locked\)/);
    assert.match(board, /const readOnly = !unlocked\.has\(draft\.frameworkKey\)/);
    assert.match(board, /\{allUnlocked \? <>/);
    assert.match(board, /"\/api\/isolated\/srs-framework\/lock", \{ frameworkKey: framework\.key, expectedVersion: framework\.version \}/);
    assert.match(board, /onClick=\{\(\) => setUnlocking\(framework\)\}>Unlock</, "an unlock opens the warning first, not the command");
    assert.match(board, /assessment\{pinned === 1 \? " is" : "s are"\} pinned to/);
    assert.doesNotMatch(board, /Start a new version|Publish version/);
  });

  it("shows the history per framework and per requirement, with who and when", () => {
    assert.match(board, /entry\.frameworkKey === historyOf\.key \|\| entry\.frameworkKey === null/);
    assert.match(board, /history\.filter\(\(entry\) => entry\.subject === open\.requirement!\.id\)/);
    assert.match(board, /\{entry\.actorName \?\? entry\.actorId\} · \{formatDateTime\(entry\.at\)\}/);
  });

  it("routes each framework command through the command runner's principal check", () => {
    for (const [path, command] of [["srs-framework/unlock/route.ts", "srs.framework.unlock"], ["srs-framework/lock/route.ts", "srs.framework.lock"],
      ["srs-framework/pillars/route.ts", "srs.framework.pillar.upsert"], ["srs-framework/requirements/route.ts", "srs.framework.requirement.upsert"],
      ["srs-framework/maturity/route.ts", "srs.framework.maturity.update"]] as const) {
      assert.match(read(`app/api/isolated/${path}`), new RegExp(`requireCommandPrincipal\\(request, "${command.replace(/\./g, "\\.")}"\\)`), path);
    }
  });
});

describe("the client's SRS area, dated on completion (R3)", () => {
  it("says in progress — with how much is addressed — or assessed, never an assessed date on a draft", () => {
    // S2: the completion reads through the dashboard model (S1's `srsCompletion`), and the date only from a completed one.
    assert.match(area, /In progress · \$\{currentCompletion\.addressed\} of \$\{currentCompletion\.total\} addressed/);
    assert.match(area, /started \{formatDate\(model\.assessment\.startedOn\)\} · not yet assessed/);
    assert.match(area, /dated as assessed only when every requirement has been addressed/);
    assert.match(area, /model\.assessment\.assessedOn\s*\?/);
    assert.match(read("../../packages/contracts/src/srsDashboard.ts"), /assessedOn: isAssessed\(assessment\) \? assessment\.assessedOn : null/);
  });

  it("holds Complete until every requirement is addressed, and reassessing starts a new assessment", () => {
    // Completing is the wizard's last screen: the button is blocked while any requirement lacks a maturity.
    assert.match(start, /blocked=\{pending \|\| !ready \|\| access\.state !== "allowed" \|\| conflict\}/);
    assert.match(area, /<StartButton clientId=\{client\.id\} access=\{access\} onSaved=\{onSaved\} onStarted=\{onStarted\} label="Reassess"/);
  });

  it("draws the trend from completed assessments only, and asks for no date at start", () => {
    const dashboard = read("../../packages/contracts/src/srsDashboard.ts");
    assert.match(dashboard, /const completed = assessments\.filter\(isAssessed\)/);
    assert.match(dashboard, /overall: completed\.map\(/);
    assert.match(area, /model\.trend\.overall\.map/);
    assert.doesNotMatch(start, /assessedOn: (?!string)/, "nothing the wizard sends carries an assessed date");
  });
});

describe("one-click start, one title, noise behind i-pills", () => {
  const forms = read("app/clients/[clientId]/SrsAssessmentForms.tsx");
  const workspaceView = read("app/clients/[clientId]/ClientWorkspaceView.tsx");
  const drawers = read("app/clients/[clientId]/srsDrawers.ts");

  it("starts the assessment in one action: no start drawer, the gated command posted from the button", () => {
    assert.doesNotMatch(forms, /SrsStartForm|Start a readiness assessment/);
    assert.doesNotMatch(workspaceView, /srs-start|SrsStartForm/);
    assert.doesNotMatch(drawers, /srs-start/);
    assert.doesNotMatch(area, /srs-start/);
    assert.match(area, /`\/api\/isolated\/clients\/\$\{encodeURIComponent\(clientId\)\}\/srs-assessments`/);
    assert.match(area, /blocked=\{pending \|\| access\.state !== "allowed"\}/);
  });

  it("applies the record pre-fill on every one-click start (a start that drops it fails here)", () => {
    assert.match(area, /\{ notes: "", prefillFromNziData: true \}/);
    assert.doesNotMatch(area, /prefillFromNziData: false/);
  });

  it("leaves per-answer overrides inside the assessment, on the item form", () => {
    assert.match(forms, /Override if the disclosure needs something different/);
    assert.match(forms, /export function SrsWizard/);
  });

  it("shows one title, not an eyebrow and a title", () => {
    assert.equal((area.match(/<h2>UK SRS Readiness<\/h2>/g) ?? []).length, 3);
    assert.doesNotMatch(area, /<div className="eyebrow">Disclosure<\/div>/);
    assert.doesNotMatch(area, /eyebrow="Disclosure"/);
  });

  it("keeps the explanatory prose behind i-pills, not inline on the page", () => {
    assert.match(area, /<InfoTip label="starting an assessment">/);
    assert.match(area, /<InfoTip label="this assessment">/);
    assert.match(area, /gated on <b>srs\.manage<\/b> and every answer is audited/);
    assert.doesNotMatch(area, /<p className="nz-maps">Requirements the client/);
    assert.doesNotMatch(area, /<p className="nz-maps">The framework is Admin-managed/);
  });
});
