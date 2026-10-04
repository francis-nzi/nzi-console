import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { getAdminOverview } from "../src/adminOverview";
import { withTenantRead } from "../src/postgres";

/**
 * The admin overview (admin Phase A1) against a real database: every figure is the organisation's own; a client is
 * linked, named-but-not-linked, or has nothing to link — three states, never folded together; and the recent changes
 * are administration only, the organisation's only, newest first.
 */
const ORG_A = "adm-org-a";
const ORG_B = "adm-org-b";

describe("the admin overview, read from the database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  const overviewOf = (org: string, includeChanges = true, changeLimit?: number) =>
    withTenantRead(database.pool, org, (db) => getAdminOverview(db, { includeChanges, changeLimit }));

  before(async () => {
    database = (await createDisposableDatabase("adminoverview"))!;
    const db = await database.admin();
    try {
      for (const org of [ORG_A, ORG_B]) {
        await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
        await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
        await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada Admin')`, [org]);
      }
      const value = (org: string, category: string, id: string, label: string, active = true, source = "import") => db.query(
        `INSERT INTO nzi_console.reference_values (organisation_id, category_key, value_id, label, active, source, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'seed', 'seed')`, [org, category, id, label, active, source]);
      await value(ORG_A, "industries", "i1", "Retail");
      await value(ORG_A, "industries", "i2", "Mining", false);
      await value(ORG_A, "referrals", "r1", "Partner", true, "admin");
      // Org B: more values, which must never show in A's figures.
      for (let n = 0; n < 5; n++) await value(ORG_B, "industries", `b${n}`, `B industry ${n}`);

      const client = (org: string, id: string, fields: Record<string, unknown>) => {
        const columns = Object.keys(fields);
        return db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status${columns.map((c) => `, ${c}`).join("")})
          VALUES ($1, $2, $2, 'active'${columns.map((_, i) => `, $${i + 3}`).join("")})`, [org, id, ...Object.values(fields)]);
      };
      await client(ORG_A, "linked", { sector: "Retail", sector_value_id: "i1", referral: "Partner", referral_value_id: "r1", client_manager: "Ada Admin", client_manager_user_id: "ada" });
      await client(ORG_A, "named", { sector: "Food", referral: "Web", client_manager: "Someone" });
      await client(ORG_A, "blank", { sector: "  ", referral: "", client_manager: null });
      await client(ORG_B, "b-client", { sector: "Retail" });

      const audit = (org: string, action: string, at: string, actor = "ada") => db.query(
        `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, occurred_at, after_json)
         VALUES ($1, gen_random_uuid()::text, $2, 'staff', $3, 'thing', 'x', 'corr', $4::timestamptz, '{"v":1}'::jsonb)`, [org, actor, action, at]);
      await audit(ORG_A, "reference.values.imported", "2026-09-29T09:00:00Z", "import:seed");
      await audit(ORG_A, "staff.role.assign", "2026-09-29T10:00:00Z");
      await audit(ORG_A, "milestones.imported", "2026-09-29T11:00:00Z", "import:nzi-pro-v7");
      await audit(ORG_A, "client.imported", "2026-09-29T12:00:00Z", "import:nzi-pro-v7"); // data, not administration
      await audit(ORG_A, "job.updated", "2026-09-29T13:00:00Z"); // not administration
      await audit(ORG_B, "reference.values.imported", "2026-09-29T14:00:00Z");
    } finally {
      await db.end();
    }
  });
  after(async () => { await database?.end(); });

  it("counts the organisation's own lookup values, per category, active and not", async () => {
    const { lookups } = await overviewOf(ORG_A);
    const industries = lookups.perCategory.find((category) => category.key === "industries")!;
    assert.deepEqual([industries.active, industries.inactive], [1, 1]);
    // 3 seeded here, plus the 6 activity types 0155 provisions for every organisation (seeded, active, not "added").
    assert.deepEqual([lookups.values, lookups.active, lookups.added], [9, 8, 1]);
    assert.ok(lookups.categories >= 2, "every active category is listed, values or none");
    assert.equal((await overviewOf(ORG_B)).lookups.values, 5 + 6, "and B's are B's alone (its 5, and its own 6 activity types)");
  });

  it("tells linked from named-but-not-linked from nothing-to-link, for each link", async () => {
    const overview = await overviewOf(ORG_A);
    assert.equal(overview.clients, 3);
    for (const link of overview.links) {
      assert.deepEqual([link.linked, link.unlinked, link.none], [1, 1, 1], link.key);
    }
  });

  it("lists administration changes only — newest first, with who did them", async () => {
    const changes = (await overviewOf(ORG_A)).recentChanges!;
    assert.deepEqual(changes.map((change) => change.action), ["milestones.imported", "staff.role.assign", "reference.values.imported"]);
    assert.equal(changes[1]!.actorLabel, "Ada Admin");
    assert.equal(changes[0]!.actorLabel, null, "an import run is not a person");
    assert.deepEqual(changes[0]!.after, { v: 1 });
  });

  it("never shows another organisation's changes", async () => {
    const changes = (await overviewOf(ORG_B)).recentChanges!;
    assert.deepEqual(changes.map((change) => change.action), ["reference.values.imported"]);
  });

  it("withholds the change list — as null, not as empty — when the viewer may not see the whole audit log", async () => {
    assert.equal((await overviewOf(ORG_A, false)).recentChanges, null);
  });

  it("bounds the change list", async () => {
    assert.equal((await overviewOf(ORG_A, true, 1)).recentChanges!.length, 1);
    assert.equal((await overviewOf(ORG_A, true, 0)).recentChanges!.length, 1, "at least one");
  });
});
