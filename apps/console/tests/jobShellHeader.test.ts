import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { datasetsSummary, milestonesSummary } from "../app/jobs/JobShellHeader";

/**
 * Phase 2 job shell (JOB-REDESIGN-phase2-kickoff): the header band's summaries say what the page already holds — the
 * first selected dataset by its #419 label and how many more; the milestones and the next one open — and a failed
 * milestones read says "unavailable", never "Not set". The shell is behind `job-shell`, so with the flag off the page is
 * today's.
 */
const APP = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "app");

describe("the job shell's header summaries", () => {
  it("names the first selected dataset and counts the rest", () => {
    assert.equal(datasetsSummary([]), "None selected");
    assert.equal(datasetsSummary([{ selected: false, label: "CEDA GB 2025" }]), "None selected");
    assert.equal(datasetsSummary([{ selected: true, label: "DESNZ GB 2025" }]), "DESNZ GB 2025");
    assert.equal(datasetsSummary([{ selected: true, label: "DESNZ GB 2025" }, { selected: false, label: "ICE GB 2026" }, { selected: true, label: "CEDA GB 2025" }]), "DESNZ GB 2025 +1");
  });

  it("counts the milestones and names the next open one; a failed read is unavailable, none is Not set", () => {
    assert.equal(milestonesSummary(null), "unavailable");
    assert.equal(milestonesSummary([]), "Not set");
    assert.equal(milestonesSummary([
      { dueDate: "2026-10-01", completedAt: "2026-09-30T10:00:00Z" },
      { dueDate: "2026-11-20", completedAt: null },
      { dueDate: "2026-10-12", completedAt: null },
    ]), "3 · next 12/10/2026");
    assert.equal(milestonesSummary([{ dueDate: "2026-10-01", completedAt: "2026-09-30T10:00:00Z" }]), "1 · all done");
    assert.equal(milestonesSummary([{ dueDate: null, completedAt: null }]), "1 · 1 undated");
  });

  it("is behind job-shell, beside the existing layouts rather than replacing them", () => {
    const workspace = readFileSync(join(APP, "jobs/CrpScopeWorkspace.tsx"), "utf8");
    assert.match(workspace, /const shellOn = dataEntryAdapterEnabled\("job-shell"\)/);
    assert.match(workspace, /\{shellOn \? shellBody : stageSectionsOn \? stageBody : \(/, "the stage-sections and legacy bodies are kept");
    assert.match(readFileSync(join(APP, "lib/featureFlags.ts"), "utf8"), /"job-shell"/);
  });

  it("opens Setup, Milestones, Time, Sites and Datasets in the Client-home overlay drawer, never the evidence slot", () => {
    const workspace = readFileSync(join(APP, "jobs/CrpScopeWorkspace.tsx"), "utf8");
    // The overlay renders nothing when closed, so the page at rest — and the capture gate's `.nz-app.no-drawer` — is
    // unchanged; the evidence drawer keeps AppShell's slot.
    assert.match(workspace, /<Drawer open=\{shellDrawerView !== null\} onClose=\{closeShellDrawer\}[^>]*className="nz-site-drawer nz-job-drawer" dismissOnOutsideClick>/);
    assert.match(workspace, /drawer=\{drawer\}/, "AppShell's drawer slot is still the evidence drawer");
    for (const drawer of ["setup", "milestones", "time", "sites", "datasets"]) assert.match(workspace, new RegExp(`\\n    ${drawer}: \\{ kicker: "Job", title: "`), `the ${drawer} drawer`);
    assert.match(workspace, /<DatasetPanel [^>]*showReasons\/>/, "the Datasets drawer says why each dataset is selected");
  });

  it("logs time in the Time drawer through the Time screen's own form and command, the job fixed — no redirect out", () => {
    const page = readFileSync(join(APP, "jobs/[jobId]/page.tsx"), "utf8");
    assert.match(page, /const shellTimePanel = <JobTimePanel [^>]*logInPlace=\{\{ jobLabel: `\$\{job\.header\.client\} · \$\{job\.header\.number\}`, today: todayInLondon\(\) \}\} \/>;/);
    assert.match(page, /const shell = \{ milestonesPanel: milestones, timePanel: shellTimePanel, milestoneStates \};/);
    assert.match(page, /const panels = <>\{milestones\}\{timePanel\}<\/>;/, "every other place keeps the panel that links to the Time screen");
    const panel = readFileSync(join(APP, "jobs/JobTimePanel.tsx"), "utf8");
    assert.match(panel, /<AddEntry [^>]*fixedJob=\{\{ jobId, label: logInPlace\.jobLabel \}\}/);
    const board = readFileSync(join(APP, "time/TimeBoard.tsx"), "utf8");
    // One form, one command: the drawer posts `time.entry.log` through the same route as the Time screen.
    assert.match(board, /export function AddEntry\(/);
    assert.match(board, /postBrowserCommand\("\/api\/isolated\/time\/entries", \{\n\s+jobId: draft\.jobId,/);
    assert.match(board, /\{fixedJob \? <div className="nz-time-field wide"><span>Job<\/span><b className="nz-time-fixed-job">\{fixedJob\.label\}<\/b><\/div>/);
    // The header's Time summary re-reads when time is logged in the drawer.
    assert.match(panel, /window\.dispatchEvent\(new Event\(JOB_TIME_CHANGED\)\)/);
    assert.match(readFileSync(join(APP, "jobs/JobShellHeader.tsx"), "utf8"), /window\.addEventListener\(JOB_TIME_CHANGED, changed\)/);
  });
});
