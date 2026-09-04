import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReportingChain } from "../src/index";

const snap = (year: number) => ({ year, snapshotId: `s-${year}`, dataHash: `sha256:${year}` });

describe("buildReportingChain (DA1 / NZC-059)", () => {
  it("orders baseline + three most recent priors + current, ascending", () => {
    const chain = buildReportingChain({
      jobId: "j", clientId: "c", currentYear: 2026, baselineYear: 2020,
      priorSnapshots: [snap(2020), snap(2021), snap(2022), snap(2023), snap(2024), snap(2025)],
      currentSnapshot: null,
    });
    assert.deepEqual(chain.entries.map((e) => [e.year, e.kind]), [
      [2020, "baseline"], [2023, "prior"], [2024, "prior"], [2025, "prior"], [2026, "current"],
    ]);
    assert.equal(chain.entries[0]!.source, "reviewed-snapshot");
    assert.equal(chain.entries.at(-1)!.source, "live");
  });

  it("marks the current year reviewed-snapshot when the job has one", () => {
    const chain = buildReportingChain({
      jobId: "j", clientId: "c", currentYear: 2026, baselineYear: 2024,
      priorSnapshots: [snap(2024), snap(2025)],
      currentSnapshot: { snapshotId: "s-current", dataHash: "sha256:cur" },
    });
    const current = chain.entries.at(-1)!;
    assert.equal(current.kind, "current");
    assert.equal(current.source, "reviewed-snapshot");
    assert.equal(current.snapshotId, "s-current");
  });

  it("keeps the baseline entry with source none when no snapshot exists for that year", () => {
    const chain = buildReportingChain({
      jobId: "j", clientId: "c", currentYear: 2026, baselineYear: 2019,
      priorSnapshots: [snap(2024), snap(2025)],
      currentSnapshot: null,
    });
    assert.equal(chain.entries[0]!.year, 2019);
    assert.equal(chain.entries[0]!.kind, "baseline");
    assert.equal(chain.entries[0]!.source, "none");
    assert.equal(chain.entries[0]!.snapshotId, null);
  });

  it("has no baseline entry when no target is set", () => {
    const chain = buildReportingChain({
      jobId: "j", clientId: "c", currentYear: 2026, baselineYear: null,
      priorSnapshots: [snap(2023), snap(2024), snap(2025)],
      currentSnapshot: null,
    });
    assert.equal(chain.baselineYear, null);
    assert.ok(!chain.entries.some((e) => e.kind === "baseline"));
    assert.deepEqual(chain.entries.map((e) => e.year), [2023, 2024, 2025, 2026]);
  });

  it("never double-counts the baseline year as a prior", () => {
    const chain = buildReportingChain({
      jobId: "j", clientId: "c", currentYear: 2026, baselineYear: 2024,
      priorSnapshots: [snap(2024), snap(2025)],
      currentSnapshot: null,
    });
    assert.equal(chain.entries.filter((e) => e.year === 2024).length, 1);
    assert.equal(chain.entries.find((e) => e.year === 2024)!.kind, "baseline");
  });

  it("tolerates gaps in the prior-year sequence", () => {
    const chain = buildReportingChain({
      jobId: "j", clientId: "c", currentYear: 2026, baselineYear: 2020,
      priorSnapshots: [snap(2020), snap(2022), snap(2025)], // 2021, 2023, 2024 missing
      currentSnapshot: null,
    });
    assert.deepEqual(chain.entries.map((e) => e.year), [2020, 2022, 2025, 2026]);
  });
});
