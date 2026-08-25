import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listClients, listJobs, withTenantRead, type Queryable } from "../src/index";

describe("isolated Postgres adapter", () => {
  it("maps canonical client and job rows without inventing presentation fields", async () => {
    const dates = { created_at: "2026-08-25T10:00:00.000Z", updated_at: "2026-08-25T11:00:00.000Z" };
    const db = {
      query: async (sql: string) => ({ rows: sql.includes("FROM nzi_console.clients")
        ? [{ organisation_id: "org-a", client_id: "client-a", name: "Synthetic Client", status: "active", version: 1, ...dates }]
        : [{ organisation_id: "org-a", job_id: "job-a", client_id: "client-a", client_name: "Synthetic Client", sequence: 612, job_number: "J000612", job_family: "crp", title: "Synthetic CRP", status: "open", workflow_stage: "setup", version: 1, ...dates }] }),
    } as Queryable;
    assert.equal((await listClients(db))[0]?.name, "Synthetic Client");
    assert.equal((await listJobs(db))[0]?.number, "J000612");
  });

  it("sets the runtime role and tenant context inside a read-only transaction", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const client = { query: async (sql: string, values?: readonly unknown[]) => { calls.push({ sql, values }); return { rows: [] }; }, release: () => undefined };
    const pool = { connect: async () => client };
    await withTenantRead(pool as never, "org-a", async () => "ok");
    assert.deepEqual(calls.map((call) => call.sql), ["BEGIN READ ONLY", "SET LOCAL ROLE nzi_console_app", "SELECT set_config('app.organisation_id', $1, true)", "COMMIT"]);
    assert.deepEqual(calls[2]?.values, ["org-a"]);
  });

  it("rolls back and releases the connection when a read fails", async () => {
    const calls: string[] = [];
    let released = false;
    const client = { query: async (sql: string) => { calls.push(sql); return { rows: [] }; }, release: () => { released = true; } };
    const pool = { connect: async () => client };
    await assert.rejects(() => withTenantRead(pool as never, "org-a", async () => { throw new Error("forced"); }));
    assert.equal(calls.at(-1), "ROLLBACK");
    assert.equal(released, true);
  });
});
