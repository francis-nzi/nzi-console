import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { netZeroDraft } from "../app/clients/netZeroDefault";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/**
 * Decision 2 (2a(ii)) — a new client's net-zero target starts at 90% by 2050, editable, in both places it is set: the
 * create wizard (the client record's pair) and the Baseline & targets editor (the targets record). Fill-blank-only.
 */
describe("the net-zero target default", () => {
  it("starts the create wizard at 2050 / 90 — the form's initial state, so it fills only a blank new client", () => {
    const wizard = read("apps/console/app/clients/new/ClientCreateWizard.tsx");
    assert.match(wizard, /\.\.\.emptyClientForm\(\), netZeroTargetYear: NET_ZERO_DEFAULT\.year, netZeroTargetReductionPct: NET_ZERO_DEFAULT\.pct,/);
    assert.doesNotMatch(read("apps/console/app/clients/clientForm.tsx").split("export function emptyClientForm")[1]!.split("}")[0]!, /netZero/,
      "emptyClientForm stays blank — the default is the wizard's, as the owner and portfolio defaults are");
  });

  it("asks for the year and a % whose label names it, both editable", () => {
    const form = read("apps/console/app/clients/clientForm.tsx");
    assert.match(form, /<Num \{\.\.\.props\} name="netZeroTargetYear" label="Net Zero target year"/);
    assert.match(form, /<Num \{\.\.\.props\} name="netZeroTargetReductionPct" label=\{netZeroPctLabel\(form\.netZeroTargetYear\)\}/);
  });

  it("starts a blank net-zero row in the targets editor from the client record's pair, else 2050 / 90 — never replacing a held target", () => {
    const held = { nearTerm: null, netZero: { year: 2040, pct: 95 }, scopes: {} };
    assert.deepEqual(netZeroDraft(held, { year: 2050, pct: 90 }), { year: "2040", pct: "95", prefilled: null }, "a held target stands");
    assert.deepEqual(netZeroDraft(null, { year: 2045, pct: 92 }), { year: "2045", pct: "92", prefilled: "profile" }, "the commitment the wizard wrote");
    assert.deepEqual(netZeroDraft({ nearTerm: { year: 2030, pct: 42 }, netZero: null, scopes: {} }, { year: 2050, pct: null }), { year: "2050", pct: "90", prefilled: "default" },
      "an unpaired record pair is not used; the default is");
    assert.deepEqual(netZeroDraft(null, null), { year: "2050", pct: "90", prefilled: "default" });
  });

  it("labels the editor's net-zero % with the year as it is edited, and passes the client record's pair in", () => {
    const targets = read("apps/console/app/clients/[clientId]/ClientTargets.tsx");
    assert.match(targets, /pair\("netZero", "Net-zero", "Target year", false, netZeroPctLabel\(draft\.netZero\.year\)\)/);
    assert.match(targets, /const \[draft, setDraft\] = useState<Draft>\(\(\) => \{\n    const \{ prefilled: _prefilled, \.\.\.netZero \} = netZeroDraft\(targets\.model, heldNetZero\);/);
    assert.match(read("apps/console/app/clients/[clientId]/ClientWorkspaceView.tsx"),
      /heldNetZero=\{\{ year: client\.profile\.netZeroTargetYear \?\? null, pct: client\.profile\.netZeroTargetReductionPct \?\? null \}\}/);
  });
});
