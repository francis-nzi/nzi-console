import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { planV7ClientImport } from "../src/v7ClientImport";
import { CLIENT_LINK_RUN_PREFIX, loadV7ClientLinks, planClientLinks, type LinkClient } from "../src/v7ClientLinkLoad";
import { loadV7ClientPlan } from "../src/v7ClientLoad";
import { loadV7Lookups, planV7Lookups } from "../src/v7LookupLoad";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { syntheticExtract, syntheticHeaders } from "./support/v7SyntheticExtract";

/**
 * The v7 client-link backfill (admin Phase A4): each imported client's sector, referral, portfolio and client-manager
 * text linked by exact, unique match — fill-NULL-only, a differing link reported as a conflict, never a lookup value
 * created, the text never touched; a version bump and one audit event per changed client; and the client loader's
 * own re-run still "already loaded and identical" afterwards. Planning is pure; the load runs as the application role.
 */

const client = (clientId: string, text: Partial<LinkClient["text"]>, link: Partial<LinkClient["link"]> = {}): LinkClient => ({
  clientId, version: 1,
  text: { sector: null, referral: null, portfolio: null, clientManager: null, ...text },
  link: { sector: null, referral: null, portfolio: null, clientManager: null, ...link },
});
const VALUES = [
  { valueId: "industries:manufacturing", category: "industries", label: "Manufacturing", active: true },
  { valueId: "industries:retail", category: "industries", label: "Retail", active: true },
  { valueId: "industries:retail-old", category: "industries", label: "retail", active: false }, // archived twin: the active one wins
  { valueId: "industries:mining", category: "industries", label: "Mining", active: false }, // archived, alone
  { valueId: "referrals:a", category: "referrals", label: "Word of mouth", active: true },
  { valueId: "referrals:b", category: "referrals", label: "word  of mouth", active: true }, // two active: ambiguous
  { valueId: "portfolios:nzi", category: "portfolios", label: "NZI", active: true },
];
const MEMBERS = [
  { userId: "u-morgan", displayName: "Morgan Manager", status: "active" },
  { userId: "u-sam-1", displayName: "Sam Same", status: "active" },
  { userId: "u-sam-2", displayName: "Sam Same", status: "active" },
  { userId: "u-gone", displayName: "Gone Person", status: "suspended" },
  { userId: "u-unnamed", displayName: null, status: "active" },
];

describe("planning the client links (no database)", () => {
  it("links sector, referral and portfolio by normalised label, and the manager by exact name", () => {
    const plan = planClientLinks({ clients: [client("c1", { sector: "  manufacturing ", portfolio: "nzi", clientManager: "Morgan Manager" })], values: VALUES, members: MEMBERS });
    assert.deepEqual(plan.changes, [{ clientId: "c1", version: 1, fills: { sector: "industries:manufacturing", portfolio: "portfolios:nzi", clientManager: "u-morgan" } }]);
    assert.deepEqual(plan.matched.sector, [{ text: "manufacturing", valueId: "industries:manufacturing", label: "Manufacturing", clients: 1 }]);
  });

  it("a manager's name must match exactly — case is not forgiven, since it names a person", () => {
    const plan = planClientLinks({ clients: [client("c1", { clientManager: "morgan manager" })], values: VALUES, members: MEMBERS });
    assert.deepEqual(plan.changes, []);
    assert.deepEqual(plan.unmatched.clientManager, [{ text: "morgan manager", clients: 1, reason: "no match" }]);
  });

  it("links only a unique match: the one active value, or else the one archived value — never one of several", () => {
    const plan = planClientLinks({
      clients: [client("c1", { sector: "RETAIL" }), client("c2", { sector: "Mining" }), client("c3", { referral: "Word of Mouth" }), client("c4", { clientManager: "Sam Same" })],
      values: VALUES, members: MEMBERS,
    });
    assert.deepEqual(plan.changes.map((change) => [change.clientId, change.fills]), [["c1", { sector: "industries:retail" }], ["c2", { sector: "industries:mining" }]]);
    assert.equal(plan.tally.sector.filledToInactive, 1, "an archived value alone is still an exact, unique match — and is counted");
    assert.deepEqual(plan.unmatched.referral, [{ text: "Word of Mouth", clients: 1, reason: "ambiguous" }]);
    assert.deepEqual(plan.unmatched.clientManager, [{ text: "Sam Same", clients: 1, reason: "ambiguous" }]);
  });

  it("does not link a manager whose one membership is not active", () => {
    const plan = planClientLinks({ clients: [client("c1", { clientManager: "Gone Person" })], values: VALUES, members: MEMBERS });
    assert.deepEqual([plan.changes, plan.unmatched.clientManager], [[], [{ text: "Gone Person", clients: 1, reason: "membership not active" }]]);
  });

  it("fills only an empty link: one already set is left, and one that differs is a conflict, not an overwrite", () => {
    const plan = planClientLinks({
      clients: [
        client("c1", { sector: "Retail", portfolio: "NZI" }, { sector: "industries:retail" }),
        client("c2", { sector: "Retail" }, { sector: "industries:manufacturing" }),
        client("c3", { sector: "Not a sector" }, { sector: "industries:mining" }),
      ],
      values: VALUES, members: MEMBERS,
    });
    assert.deepEqual(plan.changes, [{ clientId: "c1", version: 1, fills: { portfolio: "portfolios:nzi" } }]);
    assert.deepEqual(plan.conflicts, [{ clientId: "c2", field: "sector", current: "industries:manufacturing", matched: "industries:retail" }]);
    assert.deepEqual([plan.tally.sector.alreadyLinked, plan.tally.sector.conflicts], [2, 1], "a set link with unmatched text is simply already linked");
  });

  it("never creates a value: an unmatched text is reported once, with how many clients hold it", () => {
    const plan = planClientLinks({
      clients: [client("c1", { sector: "Space" }), client("c2", { sector: " space " }), client("c3", { sector: "Aquaculture" }), client("c4", { sector: "  " })],
      values: VALUES, members: MEMBERS,
    });
    assert.deepEqual(plan.changes, []);
    assert.deepEqual(plan.unmatched.sector, [
      { text: "Aquaculture", clients: 1, reason: "no match" }, { text: "space", clients: 1, reason: "no match" }, { text: "Space", clients: 1, reason: "no match" }]);
    assert.deepEqual([plan.tally.sector.unmatched, plan.tally.sector.blank], [3, 1]);
  });
});

const ORG = "net-zero-international";
const OTHER = "cl-org-b";

describe("the client-link backfill, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  const admin = async <T>(work: (db: import("pg").Client) => Promise<T>) => { const db = await database.admin(); try { return await work(db); } finally { await db.end(); } };
  const clients = (org = ORG) => admin(async (db) => (await db.query(
    `SELECT client_id, version, sector, referral, portfolio, client_manager, sector_value_id, referral_value_id, portfolio_value_id, client_manager_user_id
       FROM nzi_console.clients WHERE organisation_id = $1 ORDER BY client_id`, [org])).rows);
  const events = (correlation?: string) => admin(async (db) => (await db.query(
    `SELECT entity_id, client_id, correlation_id, before_json, after_json FROM nzi_console.audit_events
      WHERE organisation_id = $1 AND action = 'client.links.backfilled' ${correlation ? "AND correlation_id = $2" : ""} ORDER BY occurred_at`,
    correlation ? [ORG, correlation] : [ORG])).rows);
  const clientPlan = () => planV7ClientImport({ extract: syntheticExtract(), headers: syntheticHeaders(), extractSha256: "synthetic-sha" });
  let manufacturing: string;

  before(async () => {
    database = (await createDisposableDatabase("clientlinks"))!;
    await loadV7ClientPlan(database.pool, clientPlan(), { commit: true, runId: "clients-1" });
    await loadV7Lookups(database.pool, ORG, planV7Lookups(syntheticExtract()), { commit: true });
    await admin(async (db) => {
      await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'u-morgan', 'consultant', 'active', 'Morgan Manager')`, [ORG]);
      manufacturing = (await db.query(`SELECT value_id FROM nzi_console.reference_values WHERE organisation_id = $1 AND category_key = 'industries' AND legacy_db_id = '1'`, [ORG])).rows[0].value_id;
      await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [OTHER]);
      await db.query(`SELECT nzi_console.provision_organisation($1)`, [OTHER]);
      await db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, sector, client_manager, source_system, legacy_db_id)
        VALUES ($1, 'other-1', 'Other Co', 'active', 'Manufacturing', 'Morgan Manager', 'nzi-pro-v7', '1')`, [OTHER]);
    });
  });
  after(async () => { await database?.end(); });

  it("a dry run reports what it would link and keeps nothing", async () => {
    const outcome = await loadV7ClientLinks(database.pool, ORG, { commit: false });
    assert.deepEqual([outcome.clientsInScope, outcome.clientsChanged], [2, 1]);
    assert.deepEqual(outcome.changes, [{ clientId: "v7-client-1", version: 1, fills: { sector: manufacturing, portfolio: "portfolios:v7-1", clientManager: "u-morgan" } }]);
    assert.equal(outcome.tally.referral.blank, 2);
    const alpha = (await clients()).find((row) => row.client_id === "v7-client-1");
    assert.deepEqual([alpha.sector_value_id, alpha.portfolio_value_id, alpha.client_manager_user_id, alpha.version], [null, null, null, 1]);
    assert.deepEqual(await events(), []);
  });

  it("commits: fills the empty links, bumps the version, leaves the text, and records one audit event per changed client", async () => {
    await loadV7ClientLinks(database.pool, ORG, { commit: true, runId: `${CLIENT_LINK_RUN_PREFIX}first` });
    const [alpha, beta] = await clients();
    assert.deepEqual(
      [alpha.sector_value_id, alpha.referral_value_id, alpha.portfolio_value_id, alpha.client_manager_user_id, alpha.version],
      [manufacturing, null, "portfolios:v7-1", "u-morgan", 2]);
    assert.deepEqual([alpha.sector, alpha.portfolio, alpha.client_manager], ["Manufacturing", "beta PORTFOLIO", "Morgan Manager"], "the text stays as imported");
    assert.equal(beta.version, 1, "a client with nothing to link is not touched");
    const recorded = await events(`${CLIENT_LINK_RUN_PREFIX}first`);
    assert.equal(recorded.length, 1);
    assert.deepEqual([recorded[0].entity_id, recorded[0].client_id, recorded[0].before_json.sector_value_id, recorded[0].after_json.version], ["v7-client-1", "v7-client-1", null, 2]);
  });

  it("is idempotent: a re-run finds every link in place and writes nothing", async () => {
    const outcome = await loadV7ClientLinks(database.pool, ORG, { commit: true, runId: `${CLIENT_LINK_RUN_PREFIX}second` });
    assert.deepEqual([outcome.clientsChanged, outcome.tally.sector.alreadyLinked, outcome.tally.clientManager.alreadyLinked], [0, 1, 1]);
    assert.equal((await clients())[0].version, 2);
    assert.deepEqual(await events(`${CLIENT_LINK_RUN_PREFIX}second`), []);
  });

  it("the client loader's own re-run still reads every client as already loaded and identical — its compare set is the text, not the links", async () => {
    const outcome = await loadV7ClientPlan(database.pool, clientPlan(), { commit: true, runId: "clients-2" });
    assert.deepEqual(outcome.clients.map((entry) => [entry.clientId, entry.state, entry.refusal]), [["v7-client-1", "unchanged", undefined], ["v7-client-2", "unchanged", undefined]]);
    assert.equal(outcome.clients[0]!.unchanged.clients, 1);
  });

  it("a link already set that differs from the text's match is reported as a conflict and left as it is", async () => {
    const retail = await admin(async (db) => (await db.query(`SELECT value_id FROM nzi_console.reference_values WHERE organisation_id = $1 AND category_key = 'industries' AND legacy_db_id = '2'`, [ORG])).rows[0].value_id);
    await admin((db) => db.query(`UPDATE nzi_console.clients SET sector_value_id = $2 WHERE organisation_id = $1 AND client_id = 'v7-client-1'`, [ORG, retail]));
    const outcome = await loadV7ClientLinks(database.pool, ORG, { commit: true });
    assert.deepEqual(outcome.conflicts, [{ clientId: "v7-client-1", field: "sector", current: retail, matched: manufacturing }]);
    assert.equal(outcome.clientsChanged, 0);
    assert.equal((await clients())[0].sector_value_id, retail, "not overwritten");
  });

  it("never creates a lookup value from client text", async () => {
    await admin((db) => db.query(`UPDATE nzi_console.clients SET referral = 'A referral nobody has' WHERE organisation_id = $1 AND client_id = 'v7-client-2'`, [ORG]));
    const before = await admin(async (db) => (await db.query(`SELECT count(*)::int AS n FROM nzi_console.reference_values WHERE organisation_id = $1`, [ORG])).rows[0].n);
    const outcome = await loadV7ClientLinks(database.pool, ORG, { commit: true });
    assert.deepEqual(outcome.unmatched.referral, [{ text: "A referral nobody has", clients: 1, reason: "no match" }]);
    assert.equal(await admin(async (db) => (await db.query(`SELECT count(*)::int AS n FROM nzi_console.reference_values WHERE organisation_id = $1`, [ORG])).rows[0].n), before);
  });

  it("never touches another organisation's clients", async () => {
    const [other] = await clients(OTHER);
    assert.deepEqual([other.sector_value_id, other.client_manager_user_id, other.version], [null, null, 1]);
  });
});
