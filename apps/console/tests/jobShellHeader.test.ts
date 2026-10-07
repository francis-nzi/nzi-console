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
});
