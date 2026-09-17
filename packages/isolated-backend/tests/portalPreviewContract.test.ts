import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { commandGrantForRole, contractFor, roleCapabilityGrants, type StaffRole } from "@nzi/contracts";
import { getPortalPreview } from "../src/portalPreview";
import { seedPortalAcceptance } from "../src/portalAcceptanceSeed";
import type { StaffPrincipal } from "../src/auth";

/**
 * The staff portal preview, rendered end to end against a real database and checked against the
 * screen contract it is actually served under.
 *
 * **This is the test that was missing.** Thirteen unit tests asserted the preview's parts — the
 * capability, the scope parity, the resolvers it calls, the absence of a write — and every one of
 * them passed while the feature could not render at all. The payload was being validated against
 * `clientWorkspace`'s contract, which describes a different screen (`sites`, `reportingPeriods`,
 * `evidence`), so the honest-degraded guard refused it and the page showed "Workspace
 * unavailable". Nothing that tested a part could see that, because the fault was in the join
 * between the response and the contract it is served under.
 *
 * Same lesson as the seed: parts passing is not the thing working. So this drives the real
 * resolver against seeded data and asserts the result satisfies the contract the page will apply
 * to it — the assertion a browser would otherwise make first, in front of Francis.
 *
 * Skips without a throwaway database; CI always provides one.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const DATABASE_URL = process.env.NZI_TEST_DATABASE_URL;
const ORG = "ci-preview-org";
const ACTOR = "ci-preview-staff";
const CLIENT = "ci-preview-client";
const BARE_CLIENT = "ci-preview-bare";

function assertDisposable(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])(ci|test|tmp|throwaway)([_-]|$)/i.test(name)) {
    throw new Error(`Refusing to run: '${name}' is not named as a disposable database.`);
  }
  if (process.env.NZI_ISOLATED_DATABASE_URL === url) {
    throw new Error("Refusing to run: NZI_TEST_DATABASE_URL is the same database as NZI_ISOLATED_DATABASE_URL.");
  }
}

/** The principal the route builds from the staff session, with the real matrix grants. */
const staff = (role: StaffRole = "admin"): StaffPrincipal => ({
  sessionId: `ci-session-${role}`, userId: ACTOR, organisationId: ORG,
  issuedAt: Date.now(), expiresAt: Date.now() + 3_600_000,
  role, matrixVersion: commandGrantForRole(role, ORG, ACTOR).matrixVersion,
  capabilities: roleCapabilityGrants(role),
});

describe("the staff portal preview renders against its contract", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let pool: pg.Pool;

  before(async () => {
    assertDisposable(DATABASE_URL!);
    const admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS nzi_console CASCADE`);
    for (const role of ["nzi_console_app", "nzi_console_worker", "nzi_console_auth"]) {
      await admin.query(`DO $$ BEGIN CREATE ROLE ${role} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    }
    for (const filename of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, filename), "utf8"));
      if (filename.startsWith("0001_")) {
        await admin.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $2)`, [ORG, "CI"]);
      }
    }
    await admin.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    for (const [id, name] of [[CLIENT, "CI Preview Client"], [BARE_CLIENT, "CI Bare Client"]]) {
      await admin.query(
        `INSERT INTO nzi_console.clients (organisation_id, client_id, name, status)
         VALUES ($1, $2, $3, 'active') ON CONFLICT DO NOTHING`, [ORG, id, name]);
    }
    await admin.query(
      `INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status)
       VALUES ($1, $2, 'admin', 'active')
       ON CONFLICT (organisation_id, user_id) DO UPDATE SET role_id='admin', status='active'`, [ORG, ACTOR]);
    await admin.end();

    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4, application_name: "nzi-preview-ci" });
    // The same fixture the acceptance walk-through uses, so the contract is checked against the
    // data a person will actually be looking at.
    await seedPortalAcceptance(pool, { organisationId: ORG, actorId: ACTOR, clientId: CLIENT });
  });

  after(async () => { await pool?.end(); });

  const contract = contractFor("portalPreview");
  const today = () => new Date().toISOString().slice(0, 10);

  it("satisfies the portalPreview screen contract for a seeded client", async () => {
    const preview = await getPortalPreview(pool, staff(), { clientId: CLIENT, today: today() });
    assert.ok(contract.validate(preview), "the response must satisfy the contract the page validates it against");
    assert.equal(contract.isEmpty(preview), false, "a preview is never 'empty' — the client's own empty states say it better");
  });

  it("does not satisfy the clientWorkspace contract — which is why it needed its own", () => {
    // Pinning the actual defect. Reusing that key is what produced "Workspace unavailable", and
    // this fails the moment anyone points the preview back at it.
    const shaped = { client: { id: CLIENT, name: "CI Preview Client" }, strategies: {}, readiness: {}, previewedAt: "x" };
    assert.equal(contractFor("clientWorkspace").validate(shaped), false);
  });

  it("still satisfies the contract for a client with no plan and no assessment", async () => {
    // The empty case has to render, not fail. A consultant opening a brand-new client should see
    // what that client sees — their honest empty portal — not a broken screen.
    const preview = await getPortalPreview(pool, staff(), { clientId: BARE_CLIENT, today: today() });
    assert.ok(contract.validate(preview), "an unseeded client is a valid preview, not a contract failure");
    assert.equal(preview.strategies.plan.length, 0);
    assert.equal(preview.readiness.state, "none", "no assessment reads as 'none', never a zero score");
  });

  it("carries the seeded plan through the client's own resolver", async () => {
    const preview = await getPortalPreview(pool, staff(), { clientId: CLIENT, today: today() });
    assert.ok(preview.strategies.plan.length > 0, "the seeded plan is visible");
    assert.equal(preview.client.name, "CI Preview Client");
    assert.ok(preview.previewedAt.endsWith("Z"), "stamped server-side");
  });

  it("audits the open against the staff actor, never the client", async () => {
    const before = await pool.query<{ n: string }>(
      `SELECT count(*) n FROM nzi_console.audit_events WHERE organisation_id=$1 AND action='portal.preview.open'`, [ORG]);
    await getPortalPreview(pool, staff(), { clientId: CLIENT, today: today() });
    const rows = await pool.query<{ actor_id: string; principal_type: string; client_id: string }>(
      `SELECT actor_id, principal_type, client_id FROM nzi_console.audit_events
        WHERE organisation_id=$1 AND action='portal.preview.open' ORDER BY audit_event_id`, [ORG]);
    assert.equal(rows.rows.length, Number(before.rows[0]!.n) + 1, "one event per open");
    const latest = rows.rows.at(-1)!;
    assert.equal(latest.actor_id, ACTOR);
    assert.equal(latest.principal_type, "staff");
    assert.equal(latest.client_id, CLIENT, "the client is the subject, never the actor");
  });

  it("refuses a staff member without the capability", async () => {
    // Tenant/permission parity, asserted rather than assumed — a viewer must not reach a client's
    // portal by typing the URL.
    await assert.rejects(
      () => getPortalPreview(pool, staff("viewer"), { clientId: CLIENT, today: today() }),
      /capab|permission|not permitted|forbidden/i,
    );
  });

  it("refuses a client that does not exist, rather than rendering an empty one", async () => {
    await assert.rejects(() => getPortalPreview(pool, staff(), { clientId: "no-such-client", today: today() }));
  });
});
