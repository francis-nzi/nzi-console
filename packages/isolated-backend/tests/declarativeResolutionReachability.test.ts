import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * Which write paths consume the declarative resolver — named, and held to that (Stop 2, F4).
 *
 * Five functions put a factor on a scope row: `createScopeRow`, `updateScopeRow`, portal acceptance
 * (`decidePortalDataEntryReview`), emission-source sync (`syncEmissionSourceToScope` and
 * `reaggregateGroupRollup`), and year roll-forward (`rollforwardScopeRows`). Stop 2 wires the first two, and 2d the
 * third — portal acceptance. Source sync and roll-forward fall through to exactly what they did before, each with its
 * own characterise-then-wire stop to come — roll-forward first, because it copies a bad factor into next year unchecked.
 *
 * Asserted on the source because the property is structural: which code *can* reach the resolver. A test of
 * behaviour would say what one call did; this says what every call can do.
 */

const SRC = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "src");
const read = (file: string) => readFileSync(join(SRC, file), "utf8");

/** The body of an exported or local function, from its declaration to the next top-level function. */
function bodyOf(source: string, name: string): string {
  const start = source.search(new RegExp(`(?:export )?async function ${name}\\b`));
  assert.ok(start >= 0, `${name} was not found — the reachability map is out of date`);
  const rest = source.slice(start + 10);
  const next = rest.search(/\n(?:export )?(?:async )?function \w+|\nexport const /);
  return source.slice(start, next < 0 ? undefined : start + 10 + next);
}

describe("the declarative resolver is reached from the scope-row create and update commands and portal acceptance, and nowhere else", () => {
  it("is imported by the command module, and re-exported only as the read-only preview", () => {
    const importers = readdirSync(SRC).filter((file) => file.endsWith(".ts"))
      .filter((file) => /from "\.\/declarativeResolution"/.test(read(file)));
    // The commands and portal acceptance write through it; the portal grant and bucket listing read its preview (2d).
    assert.deepEqual(importers.sort(), ["index.ts", "portalDataEntry.ts", "portalDataEntryRecords.ts", "postgresCommands.ts"]);
    // The package exports the preview (Stop 2b, for the capture form) and nothing that writes.
    const reexport = read("index.ts").split("\n").filter((line) => line.includes("./declarativeResolution"));
    assert.deepEqual(reexport, ['export { previewDeclaredFactor, type DeclaredFactorPreview, type ResolutionEntry } from "./declarativeResolution";']);
    const writers = readdirSync(SRC).filter((file) => file.endsWith(".ts") && file !== "declarativeResolution.ts")
      .filter((file) => /\bapplyDeclarativeResolution\b/.test(read(file)));
    assert.deepEqual(writers.sort(), ["portalDataEntryRecords.ts", "postgresCommands.ts"],
      "the write-side resolution is reachable from somewhere other than the commands and portal acceptance");
  });

  it("is called by portal acceptance, the third write path (2d)", () => {
    assert.match(bodyOf(read("portalDataEntryRecords.ts"), "decidePortalDataEntryReview"), /applyDeclarativeResolution\(/,
      "portal acceptance does not resolve declaratively");
  });

  it("calls the pure resolver from its one adapter only", () => {
    const callers = readdirSync(SRC).filter((file) => file.endsWith(".ts"))
      .filter((file) => /\bresolveFactorForEntry\(/.test(read(file)));
    assert.deepEqual(callers, ["declarativeResolution.ts"]);
  });

  it("is called by createScopeRow and updateScopeRow", () => {
    const commands = read("postgresCommands.ts");
    for (const name of ["createScopeRow", "updateScopeRow"]) {
      assert.match(bodyOf(commands, name), /declarativeFactorFor\(/, `${name} does not resolve declaratively`);
    }
  });

  it("is not called by the two write paths Stop 2 leaves as they were", () => {
    const commands = read("postgresCommands.ts");
    for (const name of ["syncEmissionSourceToScope", "reaggregateGroupRollup", "rollforwardScopeRows"]) {
      assert.doesNotMatch(bodyOf(commands, name), /declarativeFactorFor\(|applyDeclarativeResolution\(/,
        `${name} now reaches the resolver — that is a wiring change with its own stop, not a side effect`);
    }
  });

  it("is called from exactly those two places in the command module", () => {
    const calls = [...read("postgresCommands.ts").matchAll(/await declarativeFactorFor\(/g)].length;
    assert.equal(calls, 2, `declarativeFactorFor is awaited ${calls} times; it should be twice — create and update`);
  });
});
