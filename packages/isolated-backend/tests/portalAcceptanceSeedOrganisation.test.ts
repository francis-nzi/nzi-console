import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { LIVE_ORGANISATION, LiveOrganisationRefused } from "../src/liveOrganisation";
import { resolveSeedOrganisation, seedPortalAcceptance } from "../src/portalAcceptanceSeed";
import type { PoolLike } from "../src/postgres";

/**
 * The portal acceptance seed can never reach the live organisation. `NZI_DEMO_ORGANISATION_ID` now names it (repurposed
 * at the cutover), and the seed both writes fixtures and upserts an admin membership — so its target is an explicit
 * flag, never the environment, and net-zero-international is refused even when named. No database needed: every
 * refusal here happens before one would be touched.
 */

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, "../scripts/seed-portal-acceptance.ts");

describe("the portal acceptance seed's target organisation", () => {
  it("takes the organisation from an explicit --organisation, and nothing else", () => {
    assert.equal(resolveSeedOrganisation(["node", "seed", "--organisation", "demo-nzi-console"]), "demo-nzi-console");
    assert.equal(resolveSeedOrganisation(["node", "seed", "--withdraw-all", "--organisation", " demo-nzi-console "]), "demo-nzi-console");
    assert.throws(() => resolveSeedOrganisation(["node", "seed"]), /Usage: .*never taken from the environment/);
    assert.throws(() => resolveSeedOrganisation(["node", "seed", "--organisation"]), /Usage/);
    assert.throws(() => resolveSeedOrganisation(["node", "seed", "--organisation", "--withdraw-all"]), /Usage/, "a flag is not an organisation");
  });

  it("refuses the live organisation even when it is named", () => {
    assert.throws(() => resolveSeedOrganisation(["node", "seed", "--organisation", LIVE_ORGANISATION]), LiveOrganisationRefused);
  });

  it("refuses the live organisation in the library too, before it touches the pool", async () => {
    let touched = false;
    const pool = { connect: async () => { touched = true; throw new Error("the pool was reached"); } } as unknown as PoolLike;
    const query = (pool as unknown as { query?: unknown });
    query.query = async () => { touched = true; throw new Error("the pool was queried"); };
    await assert.rejects(seedPortalAcceptance(pool, { organisationId: LIVE_ORGANISATION, actorId: "acceptance-admin", clientId: "any" }), LiveOrganisationRefused);
    assert.equal(touched, false);
  });

  it("as a script, ignores NZI_DEMO_ORGANISATION_ID — now the live organisation — and stops before the database", () => {
    const env = {
      ...process.env,
      NZI_DEMO_ORGANISATION_ID: LIVE_ORGANISATION,
      // A boundary that would pass, pointing at nothing: the refusal must come first, so it is never reached.
      NEXT_PUBLIC_APP_ENV: "staging", NZI_DATABASE_BOUNDARY: "isolated-non-production",
      NZI_ISOLATED_DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
    };
    const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", script, ...args], { env, encoding: "utf8", timeout: 60_000 });

    const unflagged = run([]);
    assert.equal(unflagged.status, 1);
    assert.match(unflagged.stderr, /Usage: seed:portal-acceptance -- --organisation/, "no flag: refused, not defaulted to the environment");
    assert.doesNotMatch(unflagged.stderr, /ECONNREFUSED|connect/, "and refused before any connection");

    const named = run(["--organisation", LIVE_ORGANISATION]);
    assert.equal(named.status, 1);
    assert.match(named.stderr, /never runs against net-zero-international/);
    assert.doesNotMatch(named.stderr, /ECONNREFUSED|connect/);
  });
});
