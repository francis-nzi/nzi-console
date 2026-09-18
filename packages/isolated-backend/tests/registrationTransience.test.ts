import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lookupVehicleByRegistration } from "../src/vehicleLookup";

/**
 * What happens to a vehicle registration (NZC-103).
 *
 * A registration is personal data: it identifies a vehicle and, for a company car or a commuting
 * entry, very often a person. Until now the guarantee about it lived in a route comment — "the
 * registration is transient — never persisted, never logged, and never echoed back in the
 * response" — and in the absence of a `DVLA_VES_API_KEY` on staging. A comment is not a guarantee
 * and an environment variable is not a test.
 *
 * ## Two different guarantees, deliberately not conflated
 *
 * **The lookup is transient.** `lookupVehicleByRegistration` takes a plate, returns a vehicle
 * specification, and keeps nothing: it writes no row, logs nothing, and does not put the plate in
 * its own result. That is what the route comment claims and what this pins.
 *
 * **The entry is not, and should not be.** A registration typed into an emission entry *is* stored,
 * as the scope row's `asset_identifier` — the column is documented as holding "a vehicle
 * registration, employee name, meter ID, or asset code" (migration `0033`). That is the identity of
 * the thing being measured, and a CRP row that cannot say which vehicle it describes is not
 * auditable. So "a registration never reaches the database" is **not** true of this system and a
 * test asserting it would be asserting the opposite of the design. It is pinned below as what it
 * is, so the two claims cannot be mistaken for one another later.
 *
 * ## No external call, provably
 *
 * `fetchImpl` is injectable, so the no-network property is asserted rather than inferred from an
 * unset key: every path here either runs the stub or runs a recording fetch that never leaves the
 * process. A test that relied on the key being absent would pass on a developer machine and reach
 * the DVLA in an environment where someone had set one.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PLATE = "AB12CDE";
/** The same plate a person would type, spacing and case included. */
const AS_TYPED = "ab12 cde";

/** A fetch that fails the test if anything reaches it, and records that it was called. */
function forbiddenFetch(): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    throw new Error("a test reached the network");
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("the lookup keeps nothing", () => {
  it("returns a vehicle without the plate anywhere in the result", async () => {
    // Serialised and searched rather than field-by-field: a plate added to a new field later would
    // pass a test that only checked the fields that existed when it was written.
    const result = await lookupVehicleByRegistration(AS_TYPED, { allowStub: true });
    assert.equal(result.ok, true);
    const serialised = JSON.stringify(result).toUpperCase();
    assert.ok(!serialised.includes(PLATE), `the plate must not appear in the result: ${serialised}`);
    assert.ok(!serialised.includes("AB12"), "nor any recognisable fragment of it");
  });

  it("still uses the plate to resolve a vehicle, so the absence is not indifference", async () => {
    // The stub is seeded from the plate. Two different registrations give different vehicles, which
    // is what makes the previous assertion meaningful rather than a test of an empty response.
    const one = await lookupVehicleByRegistration("AA11AAA", { allowStub: true });
    const two = await lookupVehicleByRegistration("ZZ99ZZZ", { allowStub: true });
    assert.equal(one.ok, true);
    assert.equal(two.ok, true);
    assert.notDeepEqual(one.ok && one.vehicle, two.ok && two.vehicle, "the plate determines the answer");
  });

  it("makes no network call when it is stubbed", async () => {
    const { impl, calls } = forbiddenFetch();
    const result = await lookupVehicleByRegistration(AS_TYPED, { allowStub: true, fetchImpl: impl });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [], "the stub path must not reach out");
  });

  it("refuses rather than reaching out when it is neither configured nor stubbed", async () => {
    // Production without a key must fail closed, not silently degrade to a guess.
    const { impl, calls } = forbiddenFetch();
    const result = await lookupVehicleByRegistration(AS_TYPED, { allowStub: false, fetchImpl: impl });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.status, 503);
    assert.deepEqual(calls, [], "an unconfigured lookup asks nobody");
  });

  it("rejects an implausible registration before doing anything at all", async () => {
    const { impl, calls } = forbiddenFetch();
    for (const bad of ["", "X", "FAR-TOO-LONG-FOR-A-PLATE"]) {
      const result = await lookupVehicleByRegistration(bad, { apiKey: "would-be-real", fetchImpl: impl });
      assert.equal(result.ok, false, `${bad} must be refused`);
    }
    assert.deepEqual(calls, [], "a malformed plate is never sent anywhere");
  });

  it("logs nothing — the module contains no logging at all", () => {
    // The quietest way a registration escapes is a log line added while debugging and left in.
    const source = readFileSync(join(ROOT, "packages/isolated-backend/src/vehicleLookup.ts"), "utf8");
    const logs = source.split("\n").filter((line) => /console\.(log|info|warn|error|debug)/.test(line));
    assert.deepEqual(logs, [], "no logging in the module that handles registrations");
  });

  it("writes nothing — the module issues no write at all", () => {
    const source = readFileSync(join(ROOT, "packages/isolated-backend/src/vehicleLookup.ts"), "utf8");
    assert.ok(!/\b(INSERT|UPDATE|DELETE)\b/i.test(source), "no write statement anywhere in the module");
  });

  it("hands the database a vehicle, never a registration — the plate stops at the boundary", () => {
    // Sharper than "the lookup takes no database handle", which is not quite true of the module: its
    // sibling `resolveVehicleFactor` does take one, because matching a factor is a read. What
    // matters is *what* crosses into it — a VehicleSpec of make, fuel and capacity, with no plate.
    // A future signature taking the registration would fail this and have to justify itself.
    const source = readFileSync(join(ROOT, "packages/isolated-backend/src/vehicleLookup.ts"), "utf8");
    assert.match(source, /export async function resolveVehicleFactor\(\s*\n?\s*db: Queryable,\s*\n?\s*jobId: string,\s*\n?\s*vehicle: VehicleSpec,/,
      "the only database-facing function here receives a vehicle, not a registration");
    assert.ok(!/registration/.test(source.slice(source.indexOf("export async function resolveVehicleFactor"))),
      "and nothing downstream of that boundary mentions a registration");
  });
});

describe("the registration a person types into an entry is stored, by design", () => {
  it("is carried as the row's asset identifier, which is documented for exactly this", () => {
    // Stated so the transient-lookup guarantee above is not read as "no registration is ever
    // stored". A CRP row that cannot say which vehicle it describes is not auditable.
    const model = readFileSync(join(ROOT, "apps/console/app/jobs/emissionEntryModel.ts"), "utf8");
    assert.ok(model.includes("assetIdentifier: draft.registration.trim() || null"),
      "the entry deliberately persists the registration as the asset identifier");

    const migration = readFileSync(
      join(ROOT, "packages/isolated-backend/migrations/0033_scope_row_asset_identifier.sql"), "utf8");
    assert.match(migration, /vehicle registration/,
      "and the column says so — if this comment goes, the design intent goes with it");
  });

  it("round-trips through the row rather than being re-looked-up", () => {
    // The stored identifier is what the editor shows next time, so a row is readable without
    // calling DVLA again — which is also why the lookup itself needs to persist nothing.
    const model = readFileSync(join(ROOT, "apps/console/app/jobs/emissionEntryModel.ts"), "utf8");
    assert.ok(model.includes(`registration: row.assetIdentifier ?? ""`));
  });
});
