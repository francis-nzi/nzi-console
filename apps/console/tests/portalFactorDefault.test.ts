import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { defaultPortalFactorId } from "../app/portal/portalFactorDefault";

/**
 * The portal pre-selects a factor only when there is exactly one to choose (NZC-160 H1).
 *
 * It used to pre-select the first factor of the bucket — first by `lower(label)`, which the database's collation
 * decides. Under byte order "UK electricity T&D" sorts before "UK electricity —", so which factor priced an
 * entry nobody touched depended on the server's locale. A default is a choice; with one authorised factor staff
 * made it, and with several nobody did, so the control starts empty and the entry cannot be sent until someone
 * picks.
 */

const FORM = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "app/portal/PortalCategoryEntry.tsx");
const option = (id: string) => ({ id, label: id, unit: "kWh" });

describe("the portal's default factor", () => {
  it("is the only factor when staff authorised exactly one", () => {
    assert.equal(defaultPortalFactorId([option("electricity-demo")]), "electricity-demo");
  });

  it("is nothing when there are several, whatever order they arrive in", () => {
    assert.equal(defaultPortalFactorId([option("electricity-td-demo"), option("electricity-demo")]), "");
    assert.equal(defaultPortalFactorId([option("electricity-demo"), option("electricity-td-demo")]), "");
  });

  it("is nothing when there are none", () => {
    assert.equal(defaultPortalFactorId([]), "");
  });

  it("is the category's declared factor when the bucket authorises it, however many others it offers (Stop 2d, P4)", () => {
    assert.equal(defaultPortalFactorId([option("electricity-td-demo"), option("electricity-demo")], "electricity-demo"), "electricity-demo");
    assert.equal(defaultPortalFactorId([option("electricity-demo"), option("electricity-td-demo")], "electricity-demo"), "electricity-demo");
  });

  it("ignores a declared factor the bucket does not authorise — a default is never a factor staff did not grant", () => {
    assert.equal(defaultPortalFactorId([option("a"), option("b")], "electricity-demo"), "");
    assert.equal(defaultPortalFactorId([option("a")], "electricity-demo"), "a");
    assert.equal(defaultPortalFactorId([option("a"), option("b")], null), "");
  });

  it("is what the portal surface actually uses — it no longer reaches for the first factor", () => {
    // Asserted on the source because the regression is a shape: `factors[0]` anywhere in the surface is a
    // default chosen by collation.
    const source = readFileSync(FORM, "utf8");
    assert.ok(!source.includes("factors[0]"), "the portal still defaults to the first factor it was sent");
    assert.ok(source.includes("defaultPortalFactorId("), "the portal does not use the shared default");
  });

  it("is the only place in the console that may reach for a first factor", () => {
    // The whole app, not one surface: the last two survivors of the H1 anti-pattern were a draft mapping the portal
    // could not reach and a fallback form one feature flag away from live. "Unreachable today" is not a defence.
    const APP = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "app");
    const offenders = readdirSync(APP, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file) && !file.endsWith("portalFactorDefault.ts"))
      .filter((file) => /factors\s*\[\s*0\s*\]/.test(readFileSync(join(APP, file), "utf8")));
    assert.deepEqual(offenders, [], "a first-factor default outside the shared one");
  });
});
