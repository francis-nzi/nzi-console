import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { clientListSpec, defaultListQuery, jobListSpec, NONE_VALUE, type ClientListQuery, type JobListQuery } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { listClients, listJobs } from "../src/listReads";
import { withTenantRead } from "../src/postgres";

/**
 * The Clients and Jobs lists against a real database (docs/LIST_PARITY_DESIGN.md §5).
 *
 * The two organisations deliberately share values — an industry, an owner's name, a portfolio — so a filter
 * option or a count that leaked across the boundary would show up as a wrong number, not only as a stray row. Org B
 * also holds values org A has nothing like ("Secret…"), so a search or filter that crossed would find something.
 *
 * Nothing in the list SQL names an organisation: `withTenantRead` sets the tenant and switches to the app role, and
 * row-level security does the scoping. These tests are what hold that to account.
 */

const ORG_A = "list-org-a";
const ORG_B = "list-org-b";
const TODAY = "2026-09-29";

const clientQuery = (change: Partial<ClientListQuery> = {}): ClientListQuery => ({ ...defaultListQuery(clientListSpec), ...change });
const jobQuery = (change: Partial<JobListQuery> = {}): JobListQuery => ({ ...defaultListQuery(jobListSpec), ...change });

describe("the paged lists, read from the database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  const clientsIn = (org: string, query: ClientListQuery) => withTenantRead(database.pool, org, (db) => listClients(db, query));
  const jobsIn = (org: string, query: JobListQuery) => withTenantRead(database.pool, org, (db) => listJobs(db, query, { today: TODAY }));
  const names = (page: { rows: Array<{ name: string }> }) => page.rows.map((row) => row.name);

  before(async () => {
    database = (await createDisposableDatabase("listpage"))!;
    const db = await database.admin();
    try {
      for (const org of [ORG_A, ORG_B]) {
        await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [org]);
        await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
        for (const [user, display] of [["ann", "Ann Able"], ["mo", "Mo Moss"]]) {
          await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name) VALUES ($1,$2,'consultant','active',$3)`, [org, user, display]);
        }
      }
      const client = (org: string, id: string, name: string, fields: Record<string, unknown>) => {
        const columns = Object.keys(fields);
        return db.query(
          `INSERT INTO nzi_console.clients (organisation_id,client_id,name${columns.map((column) => `,${column}`).join("")})
           VALUES ($1,$2,$3${columns.map((_, index) => `,$${index + 4}`).join("")})`,
          [org, id, name, ...Object.values(fields)]);
      };
      // Org A — five clients.
      await client(ORG_A, "a1", "Alder Foods", { status: "active", sector: "Food", owner_name: "Ann Able", portfolio: "NZI", client_manager: "Mo Moss", completeness_percent: 80, latest_footprint_tco2e: 120 });
      // Owner by id: the roster's name wins over the stale text on the record, as clientReferences resolves it.
      await client(ORG_A, "a2", "Birch Retail", { status: "onboarding", sector: "Retail", owner_user_id: "ann", owner_name: "stale text", portfolio: "Partner", completeness_percent: 40 });
      // Nothing recorded — blanks, not NULLs, to prove a blank is "Unspecified"/"Unassigned".
      await client(ORG_A, "a3", "Cedar Works", { status: "prospect", sector: "  ", owner_name: "", portfolio: "" });
      await client(ORG_A, "a4", "Delta 100% Ltd", { status: "at-risk", sector: "Retail", owner_name: "Mo Moss", portfolio: "NZI", client_manager_user_id: "mo", completeness_percent: 90, latest_footprint_tco2e: 50 });
      await client(ORG_A, "a5", "Echo_Co", { status: "active", sector: "Food", owner_name: "Mo Moss", portfolio: "NZI" });
      // Org B — the same industry, owner and portfolio as A, plus values A has nothing like.
      await client(ORG_B, "b1", "Zulu Foods", { status: "active", sector: "Food", owner_name: "Ann Able", portfolio: "NZI" });
      await client(ORG_B, "b2", "Bravo Secret", { status: "active", sector: "Secret Industry", owner_name: "Secret Owner", portfolio: "Secret Portfolio", client_manager: "Secret Manager" });

      let sequence = 1;
      const job = (org: string, id: string, clientId: string, fields: Record<string, unknown>) => {
        const columns = Object.keys(fields);
        return db.query(
          `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,workflow_stage${columns.map((column) => `,${column}`).join("")})
           VALUES ($1,$2,$3,$4,'Setup'${columns.map((_, index) => `,$${index + 5}`).join("")})`,
          [org, id, clientId, sequence++, ...Object.values(fields)]);
      };
      // J000001 — manager by id on the job.
      await job(ORG_A, "ja1", "a1", { job_family: "crp", title: "CRP 2025", status: "open", client_manager_user_id: "ann", owner_name: "Owner Text", due_date: "2026-10-09", progress_percent: 50 });
      // J000002 — no job manager: the job's owner.
      await job(ORG_A, "ja2", "a4", { job_family: "consultancy", title: "Strategy work", status: "cancelled", owner_name: "Owner Text", due_date: "2026-11-01" });
      // J000003 — neither: the client's manager (a4's, by id).
      await job(ORG_A, "ja3", "a4", { job_family: "lca", title: "Bottle LCA", status: "complete", owner_name: "", progress_percent: 100 });
      // J000004 — nothing at all anywhere: Unassigned.
      await job(ORG_A, "ja4", "a3", { job_family: "crp", title: "Baseline", status: "draft", due_date: "2027-03-31" });
      // J000005 — org B.
      await job(ORG_B, "jb1", "b2", { job_family: "crp", title: "Secret job", status: "open", owner_name: "Secret Owner", due_date: "2026-10-01" });
      await db.query(`UPDATE nzi_console.jobs SET legacy_job_number='J000497', source_system='nzi-pro-v7', legacy_db_id='487' WHERE job_id='ja1'`);
    } finally {
      await db.end();
    }
  });

  after(async () => { await database?.end(); });

  describe("tenant isolation", () => {
    it("never returns another organisation's clients to a search", async () => {
      const page = await clientsIn(ORG_A, clientQuery({ search: "secret" }));
      assert.deepEqual(page.rows, []);
      assert.equal(page.total, 0);
      assert.equal(page.unfilteredTotal, 5, "org A's own five, and only those");
      assert.equal((await clientsIn(ORG_A, clientQuery({ search: "Zulu" }))).total, 0);
    });

    it("never returns another organisation's clients to a filter", async () => {
      for (const [key, value] of [["industry", "Secret Industry"], ["owner", "Secret Owner"], ["portfolio", "Secret Portfolio"], ["manager", "Secret Manager"]] as const) {
        const page = await clientsIn(ORG_A, clientQuery({ filters: { [key]: [value] } }));
        assert.equal(page.total, 0, `${key}=${value}`);
      }
    });

    it("offers only the organisation's own values, counted over its own rows", async () => {
      const { filterOptions } = await clientsIn(ORG_A, clientQuery());
      const everything = JSON.stringify(filterOptions);
      assert.doesNotMatch(everything, /Secret/);
      // "Food" and "NZI" exist in both organisations; A's counts must be A's alone.
      assert.deepEqual(filterOptions.industry.find((option) => option.value === "Food"), { value: "Food", label: "Food", count: 2 });
      assert.deepEqual(filterOptions.portfolio.find((option) => option.value === "NZI"), { value: "NZI", label: "NZI", count: 3 });
      assert.equal(filterOptions.owner.find((option) => option.value === "Ann Able")?.count, 2);
    });

    it("keeps the summary to the organisation's own rows", async () => {
      assert.equal((await clientsIn(ORG_B, clientQuery())).summary.clients, 2);
      assert.equal((await clientsIn(ORG_A, clientQuery())).summary.clients, 5);
    });

    it("never returns another organisation's jobs, options or totals", async () => {
      const search = await jobsIn(ORG_A, jobQuery({ search: "secret", filters: { status: ["all"] } }));
      assert.equal(search.total, 0);
      assert.equal((await jobsIn(ORG_A, jobQuery({ filters: { client: ["b2"], status: ["all"] } }))).total, 0, "B's client id, named outright");
      const all = await jobsIn(ORG_A, jobQuery({ filters: { status: ["all"] } }));
      assert.equal(all.unfilteredTotal, 4);
      assert.doesNotMatch(JSON.stringify(all.filterOptions), /Secret/);
      assert.equal(all.filterOptions.family.find((option) => option.value === "crp")?.count, 2);
    });

    it("refuses to read at all without a tenant", async () => {
      await assert.rejects(() => withTenantRead(database.pool, "", (db) => listClients(db, clientQuery())));
    });
  });

  describe("clients", () => {
    it("searches name and industry, ignoring case", async () => {
      assert.deepEqual(names(await clientsIn(ORG_A, clientQuery({ search: "FOOD" }))), ["Alder Foods", "Echo_Co"]);
      assert.deepEqual(names(await clientsIn(ORG_A, clientQuery({ search: "retail" }))), ["Birch Retail", "Delta 100% Ltd"]);
    });

    it("matches %, _ and \\ in a search literally, never as wildcards", async () => {
      assert.deepEqual(names(await clientsIn(ORG_A, clientQuery({ search: "100%" }))), ["Delta 100% Ltd"]);
      assert.deepEqual(names(await clientsIn(ORG_A, clientQuery({ search: "_" }))), ["Echo_Co"]);
      assert.deepEqual(names(await clientsIn(ORG_A, clientQuery({ search: "%" }))), ["Delta 100% Ltd"]);
      assert.equal((await clientsIn(ORG_A, clientQuery({ search: "\\" }))).total, 0);
    });

    it("binds a hostile filter value as data", async () => {
      const page = await clientsIn(ORG_A, clientQuery({ filters: { industry: ["'; DROP TABLE nzi_console.clients; --"] } }));
      assert.equal(page.total, 0);
      assert.equal((await clientsIn(ORG_A, clientQuery())).total, 5, "the table is still there");
    });

    it("filters on the label the row displays — the roster's name over the stale text", async () => {
      const page = await clientsIn(ORG_A, clientQuery({ filters: { owner: ["Ann Able"] } }));
      assert.deepEqual(names(page), ["Alder Foods", "Birch Retail"]);
      assert.equal(page.rows[1]!.owner, "Ann Able");
      assert.equal((await clientsIn(ORG_A, clientQuery({ filters: { owner: ["stale text"] } }))).total, 0);
      assert.deepEqual(names(await clientsIn(ORG_A, clientQuery({ filters: { manager: ["Mo Moss"] } }))), ["Alder Foods", "Delta 100% Ltd"]);
    });

    it("treats a blank as Unspecified/Unassigned, and filters on it", async () => {
      const { filterOptions } = await clientsIn(ORG_A, clientQuery());
      assert.deepEqual(filterOptions.industry.at(-1), { value: NONE_VALUE, label: "Unspecified", count: 1 });
      assert.deepEqual(filterOptions.owner.at(-1), { value: NONE_VALUE, label: "Unassigned", count: 1 });
      assert.deepEqual(names(await clientsIn(ORG_A, clientQuery({ filters: { industry: [NONE_VALUE] } }))), ["Cedar Works"]);
      assert.deepEqual(names(await clientsIn(ORG_A, clientQuery({ filters: { portfolio: [NONE_VALUE, "Partner"] } }))), ["Birch Retail", "Cedar Works"]);
    });

    it("combines filters with each other and with the search", async () => {
      assert.deepEqual(names(await clientsIn(ORG_A, clientQuery({ filters: { industry: ["Retail"], status: ["at-risk"] } }))), ["Delta 100% Ltd"]);
      assert.deepEqual(names(await clientsIn(ORG_A, clientQuery({ search: "o", filters: { portfolio: ["NZI"] } }))), ["Alder Foods", "Echo_Co"]);
    });

    it("counts each filter's options over the search and the other filters, not its own (ruled D4)", async () => {
      const { filterOptions } = await clientsIn(ORG_A, clientQuery({ filters: { status: ["active"] } }));
      // Industry is narrowed by the status filter: only the two active clients count.
      assert.deepEqual(filterOptions.industry, [{ value: "Food", label: "Food", count: 2 }]);
      // Status is not narrowed by itself, so every status stays choosable.
      assert.deepEqual(filterOptions.status.map((option) => option.value).sort(), ["active", "at-risk", "onboarding", "prospect"]);
    });

    it("keeps a chosen value in its options even when the search leaves it nothing", async () => {
      const { filterOptions } = await clientsIn(ORG_A, clientQuery({ search: "Cedar", filters: { owner: ["Ann Able"] } }));
      assert.deepEqual(filterOptions.owner.find((option) => option.value === "Ann Able"), { value: "Ann Able", label: "Ann Able", count: 0 });
    });

    it("sorts each way, blanks last both ways, and breaks ties by id", async () => {
      assert.deepEqual(names(await clientsIn(ORG_A, clientQuery({ sort: { key: "name", dir: "desc" } }))), ["Echo_Co", "Delta 100% Ltd", "Cedar Works", "Birch Retail", "Alder Foods"]);
      const owners = await clientsIn(ORG_A, clientQuery({ sort: { key: "owner", dir: "asc" } }));
      assert.deepEqual(names(owners), ["Alder Foods", "Birch Retail", "Delta 100% Ltd", "Echo_Co", "Cedar Works"]);
      const ownersDesc = await clientsIn(ORG_A, clientQuery({ sort: { key: "owner", dir: "desc" } }));
      assert.deepEqual(names(ownersDesc), ["Echo_Co", "Delta 100% Ltd", "Birch Retail", "Alder Foods", "Cedar Works"]);
      assert.deepEqual(names(await clientsIn(ORG_A, clientQuery({ sort: { key: "emissions", dir: "desc" } }))).slice(0, 2), ["Alder Foods", "Delta 100% Ltd"]);
    });

    it("pages, reports the page count, and serves a page past the end as the last page", async () => {
      const first = await clientsIn(ORG_A, clientQuery({ pageSize: 2 }));
      assert.deepEqual([first.total, first.pageCount, first.page], [5, 3, 1]);
      assert.deepEqual(names(first), ["Alder Foods", "Birch Retail"]);
      assert.deepEqual(names(await clientsIn(ORG_A, clientQuery({ pageSize: 2, page: 2 }))), ["Cedar Works", "Delta 100% Ltd"]);
      const last = await clientsIn(ORG_A, clientQuery({ pageSize: 2, page: 3 }));
      assert.deepEqual(names(last), ["Echo_Co"]);
      const beyond = await clientsIn(ORG_A, clientQuery({ pageSize: 2, page: 9 }));
      assert.equal(beyond.page, 3);
      assert.deepEqual(names(beyond), ["Echo_Co"]);
    });

    it("tells none-yet from none-match", async () => {
      const none = await clientsIn(ORG_A, clientQuery({ search: "no such client" }));
      assert.deepEqual([none.total, none.unfilteredTotal, none.pageCount, none.page], [0, 5, 1, 1]);
    });

    it("computes the metric strip over the filtered set, not the page", async () => {
      const { summary } = await clientsIn(ORG_A, clientQuery({ pageSize: 2 }));
      // The average is over the clients with a completeness recorded (80, 40, 90) — two have none, and an unknown is
      // not a nought. The board used to average in the browser with a missing value counted as 0.
      assert.deepEqual(summary, { clients: 5, openJobs: 2, averageCompleteness: 70, atRisk: 1, withoutOwner: 1, deliveryClients: 4, deliveryWithoutJobs: 2, activeWithoutEmissions: 1 });
      const retail = (await clientsIn(ORG_A, clientQuery({ filters: { industry: ["Retail"] } }))).summary;
      assert.deepEqual([retail.clients, retail.atRisk, retail.averageCompleteness], [2, 1, 65]);
    });

    it("carries the drawer's detail on the rows of the page", async () => {
      const [alder] = (await clientsIn(ORG_A, clientQuery({ search: "Alder" }))).rows;
      assert.deepEqual(alder!.jobs, [{ number: "J000001", year: null, status: "Setup" }]);
      assert.equal(alder!.latestFootprint, "120 tCO₂e");
      assert.equal(alder!.openJobs, 1);
    });
  });

  describe("jobs", () => {
    const numbers = (page: { rows: Array<{ number: string }> }) => page.rows.map((row) => row.number);

    it("shows every status except cancelled by default, newest first (ruled D5)", async () => {
      const page = await jobsIn(ORG_A, jobQuery());
      assert.deepEqual(numbers(page), ["J000004", "J000003", "J000001"]);
      assert.deepEqual(numbers(await jobsIn(ORG_A, jobQuery({ filters: { status: ["all"] } }))), ["J000004", "J000003", "J000002", "J000001"]);
      assert.deepEqual(numbers(await jobsIn(ORG_A, jobQuery({ filters: { status: ["cancelled"] } }))), ["J000002"]);
    });

    it("resolves the manager as job manager, then job owner, then client manager (ruled D3)", async () => {
      const managers = Object.fromEntries((await jobsIn(ORG_A, jobQuery({ filters: { status: ["all"] } }))).rows.map((row) => [row.number, row.manager]));
      assert.deepEqual(managers, { J000001: "Ann Able", J000002: "Owner Text", J000003: "Mo Moss", J000004: null });
      assert.deepEqual(numbers(await jobsIn(ORG_A, jobQuery({ filters: { manager: [NONE_VALUE] } }))), ["J000004"]);
      assert.deepEqual(numbers(await jobsIn(ORG_A, jobQuery({ filters: { manager: ["Mo Moss"] } }))), ["J000003"]);
    });

    it("searches the job number, v7's number, the title and the client", async () => {
      assert.deepEqual(numbers(await jobsIn(ORG_A, jobQuery({ search: "000003" }))), ["J000003"]);
      assert.deepEqual(numbers(await jobsIn(ORG_A, jobQuery({ search: "J000497" }))), ["J000001"]);
      assert.deepEqual(numbers(await jobsIn(ORG_A, jobQuery({ search: "bottle" }))), ["J000003"]);
      assert.deepEqual(numbers(await jobsIn(ORG_A, jobQuery({ search: "delta", filters: { status: ["all"] } }))), ["J000003", "J000002"]);
    });

    it("filters by family, by client and by an end-date range, inclusive at both ends", async () => {
      assert.deepEqual(numbers(await jobsIn(ORG_A, jobQuery({ filters: { family: ["crp"] } }))), ["J000004", "J000001"]);
      assert.deepEqual(numbers(await jobsIn(ORG_A, jobQuery({ filters: { client: ["a4"], status: ["all"] } }))), ["J000003", "J000002"]);
      assert.deepEqual(numbers(await jobsIn(ORG_A, jobQuery({ filters: { dueFrom: ["2026-10-09"], dueTo: ["2027-03-31"], status: ["all"] } }))), ["J000004", "J000002", "J000001"]);
      assert.deepEqual(numbers(await jobsIn(ORG_A, jobQuery({ filters: { dueTo: ["2026-10-08"] } }))), []);
    });

    it("sorts by end date with undated jobs last, both ways", async () => {
      assert.deepEqual(numbers(await jobsIn(ORG_A, jobQuery({ sort: { key: "dueDate", dir: "asc" } }))), ["J000001", "J000004", "J000003"]);
      assert.deepEqual(numbers(await jobsIn(ORG_A, jobQuery({ sort: { key: "dueDate", dir: "desc" } }))), ["J000004", "J000001", "J000003"]);
    });

    it("computes the metric strip over the filtered set, from the operating day given", async () => {
      // Progress averages the jobs that record one (50, 100); J000004 records none. Due within 30 days of 29 Sep:
      // J000001 (9 Oct) — J000004 (31 Mar) is not, and J000002 is cancelled so outside the default view.
      assert.deepEqual((await jobsIn(ORG_A, jobQuery())).summary, { jobs: 3, carbonReporting: 2, averageProgress: 75, dueWithin30Days: 1 });
    });
  });
});
