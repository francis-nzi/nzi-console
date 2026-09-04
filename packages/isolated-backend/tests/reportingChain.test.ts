import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveCrpReportingChain, withTenantRead } from "../src/index";

function chainPool(opts: {
  jobFamily?: string;
  reportingYear?: number | null;
  baselineYear?: number | null;
  priors?: Array<{ year: number; id: string }>;
  currentSnapshot?: { id: string } | null;
}) {
  const client = {
    async query(sql: string) {
      if (sql.startsWith("BEGIN") || sql.startsWith("SET LOCAL") || sql.includes("set_config") || sql.startsWith("COMMIT")) return { rows: [] };
      if (sql.includes("FROM nzi_console.jobs WHERE job_id")) return { rows: opts.jobFamily === undefined || opts.jobFamily === "crp" ? [{ client_id: "client-a", reporting_year: opts.reportingYear ?? 2026, start_date: "2026-01-01", job_family: "crp" }] : opts.jobFamily === null ? [] : [{ client_id: "client-a", reporting_year: 2026, start_date: "2026-01-01", job_family: opts.jobFamily }] };
      if (sql.includes("job_emissions_targets")) return { rows: opts.baselineYear == null ? [] : [{ baseline_year: opts.baselineYear }] };
      if (sql.includes("DISTINCT ON") && sql.includes("reviewed_crp_snapshots")) return { rows: (opts.priors ?? []).map((p) => ({ snapshot_id: p.id, data_hash: `sha256:${p.year}`, reporting_year: p.year })) };
      if (sql.includes("ORDER BY snapshot_version DESC LIMIT 1")) return { rows: opts.currentSnapshot ? [{ snapshot_id: opts.currentSnapshot.id, data_hash: "sha256:cur" }] : [] };
      return { rows: [] };
    },
    release() {},
  };
  return { connect: async () => client } as never;
}

const read = (pool: never) => withTenantRead(pool, "org-a", (db) => resolveCrpReportingChain(db, "job-a"));

describe("resolveCrpReportingChain (DA1)", () => {
  it("resolves baseline from the target and priors from client snapshots", async () => {
    const chain = await read(chainPool({
      baselineYear: 2022,
      priors: [{ year: 2022, id: "s22" }, { year: 2023, id: "s23" }, { year: 2024, id: "s24" }, { year: 2025, id: "s25" }],
      currentSnapshot: null,
    }));
    assert.equal(chain!.baselineYear, 2022);
    assert.equal(chain!.currentYear, 2026);
    assert.deepEqual(chain!.entries.map((e) => [e.year, e.kind]), [[2022, "baseline"], [2023, "prior"], [2024, "prior"], [2025, "prior"], [2026, "current"]]);
  });

  it("returns null for a non-CRP job", async () => {
    assert.equal(await read(chainPool({ jobFamily: "lca" })), null);
  });

  it("current year is live when the job has no reviewed snapshot", async () => {
    const chain = await read(chainPool({ baselineYear: 2025, priors: [{ year: 2025, id: "s25" }], currentSnapshot: null }));
    assert.equal(chain!.entries.at(-1)!.source, "live");
  });

  it("current year is reviewed-snapshot when the job has one", async () => {
    const chain = await read(chainPool({ baselineYear: 2025, priors: [{ year: 2025, id: "s25" }], currentSnapshot: { id: "s-cur" } }));
    assert.equal(chain!.entries.at(-1)!.source, "reviewed-snapshot");
    assert.equal(chain!.entries.at(-1)!.snapshotId, "s-cur");
  });

  it("no target ⇒ no baseline entry", async () => {
    const chain = await read(chainPool({ baselineYear: null, priors: [{ year: 2024, id: "s24" }, { year: 2025, id: "s25" }], currentSnapshot: null }));
    assert.equal(chain!.baselineYear, null);
    assert.ok(!chain!.entries.some((e) => e.kind === "baseline"));
  });
});
