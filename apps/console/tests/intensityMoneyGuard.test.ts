import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { commandGrantForRole, validateCommand, type CommandContext } from "@nzi/contracts";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/**
 * RULING-report-denominator-unitkind: an employees or floor-area measure can't count money. The refusal reaches the person
 * who tried — the drawer shows a refused command's own first issue, and for the drawer's own input that issue is this one.
 */
describe("the drawer surfaces the money refusal (RULING-report-denominator-unitkind)", () => {
  it("the drawer's own input for a currency \"Employees\" is refused with exactly one issue — the money one, in plain words", () => {
    const context: CommandContext = { organisationId: "o", actorId: "a", principal: "staff", idempotencyKey: "k", correlationId: "c", grant: commandGrantForRole("admin", "o", "a") };
    // What NewMetric sends for a measure named "Employees" counting money (key from the name; the currency wording placeholder).
    const issues = validateCommand("client.intensityMetric.set", { clientId: "c", metricKey: "employees", label: "Employees", unitWording: "currency", unitKind: "currency", divider: 1, iconKey: "people", ordering: 3, expectedVersion: 0 }, context);
    assert.deepEqual(issues.map((issue) => issue.field), ["unitKind"]);
    assert.equal(issues[0]!.message, "Employees and floor area count a thing, never money, so this metric can't count the client's currency. Choose a unit instead.");
  });

  it("a refused command reaches the drawer as its issues, and the drawer shows the first one's message", () => {
    assert.match(read("apps/console/app/lib/commandResponse.ts"), /error instanceof CommandValidationError\) return Response\.json\(\{ code: "VALIDATION_FAILED", message: "Command validation failed\.", issues: error\.issues \}, \{ status: 422 \}\)/);
    assert.match(read("apps/console/app/clients/[clientId]/IntensityMetricsDrawer.tsx"), /result\.state === "validation_failed" \? \(result\.issues\[0\]\?\.message \?\? result\.message\)/);
  });
});
