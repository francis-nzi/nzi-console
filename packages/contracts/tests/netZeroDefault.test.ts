import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandGrantForRole, NET_ZERO_DEFAULT, netZeroPctLabel, validateCommand, type CommandContext } from "../src/index";

const context: CommandContext = { organisationId: "org-nzi", actorId: "user-1", principal: "staff", idempotencyKey: "idem-1", correlationId: "corr-1", grant: commandGrantForRole("admin", "org-nzi", "user-1") };
const client = { name: "Example Ltd", status: "onboarding" as const, sector: "Manufacturing", location: "Leeds", owner: "Ada" };
const fields = (issues: Array<{ field: string }>) => issues.map((issue) => issue.field).sort();

/** Decision 2 (2a(ii)): a net-zero target defaults to 90% by 2050, editable; the % names the year. */
describe("the net-zero target default", () => {
  it("is NZI's methodology minimum: a 90% reduction by 2050", () => {
    assert.deepEqual(NET_ZERO_DEFAULT, { year: 2050, pct: 90 });
  });

  it("names the client's year in the reduction-% label, defaulting to 2050", () => {
    assert.equal(netZeroPctLabel(2050), "Net Zero target % 2050");
    assert.equal(netZeroPctLabel(2040), "Net Zero target % 2040");
    assert.equal(netZeroPctLabel("2045"), "Net Zero target % 2045", "as typed in the year field");
    for (const blank of [null, undefined, "", " ", "20", "abc", 1999, 2101, 2040.5]) assert.equal(netZeroPctLabel(blank as never), "Net Zero target % 2050", String(blank));
  });

  it("saves as the wizard sends it, and saves a more ambitious override — an earlier year, a higher %", () => {
    assert.deepEqual(validateCommand("client.create", { ...client, netZeroTargetYear: NET_ZERO_DEFAULT.year, netZeroTargetReductionPct: NET_ZERO_DEFAULT.pct }, context), []);
    assert.deepEqual(validateCommand("client.create", { ...client, netZeroTargetYear: 2040, netZeroTargetReductionPct: 100 }, context), []);
    // Cleared to nothing is still allowed; a year left without its % is refused — the pair rule the default keeps whole.
    assert.deepEqual(validateCommand("client.create", { ...client, netZeroTargetYear: null, netZeroTargetReductionPct: null }, context), []);
    assert.deepEqual(fields(validateCommand("client.create", { ...client, netZeroTargetYear: 2050, netZeroTargetReductionPct: null }, context)), ["netZeroTargetReductionPct"]);
  });
});
