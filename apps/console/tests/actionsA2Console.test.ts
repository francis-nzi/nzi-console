import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * Actions A2 in the console: the portal's hand in the plan ships dark behind its own flag, writes only through its own
 * routes as the portal principal for the session's client, offers no delete, and never acts in the staff preview; the
 * CRM's proposals queue rules once (approve / decline with a reason), and promotion into the library is offered only to
 * the library capability.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, "..", path), "utf8");
const root = (path: string) => readFileSync(join(here, "..", "..", "..", path), "utf8");
const flags = read("app/lib/portalFlags.ts");
const plan = read("app/api/portal/strategies/route.ts");
const proposals = read("app/api/portal/strategies/proposals/route.ts");
const view = read("app/portal/PortalReductionPlan.tsx");
const staffProposals = read("app/api/isolated/clients/[clientId]/strategies/proposals/route.ts");
const promote = read("app/api/isolated/reduction-strategies/promote/route.ts");
const workspace = read("app/clients/[clientId]/ClientWorkspaceView.tsx");
const area = read("app/clients/[clientId]/ReductionStrategiesArea.tsx");
const forms = read("app/clients/[clientId]/StrategyForms.tsx");

describe("the client's hand in the plan (portal)", () => {
  it("ships dark: the token is declared and is not in render.yaml", () => {
    assert.match(flags, /\| "portal-plan-participation"/);
    assert.doesNotMatch(root("render.yaml"), /portal-plan-participation/);
  });

  it("gates every write route on the flag and the portal origin, and takes the client from the session", () => {
    for (const [name, source, writes] of [["plan", plan, 2], ["proposals", proposals, 1]] as const) {
      assert.equal(source.split("requirePortalPlanParticipation();").length - 1, writes, `${name}: every write is behind the flag`);
      assert.equal(source.split("requirePortalOrigin(request);").length - 1, writes, `${name}: and the portal origin`);
      assert.match(source, /clientId: user\.clientId/, `${name}: the client is the session's`);
      assert.match(source, /portalCommandContext\(request, user\)/, `${name}: run as the portal principal`);
      assert.doesNotMatch(source, /export async function (DELETE|PUT)\b/, `${name}: no delete`);
    }
    assert.match(plan, /participation: portalFeatureEnabled\("portal-plan-participation"\)/, "the read offers participation only when on");
  });

  it("opens its drawers as overlays, as the Data view does — not inline in the page (and the readiness drawer too)", () => {
    // `nz-pdv-drawer` sets only a width; `nz-site-drawer` is what fixes the panel to the side over a backdrop. Found in the
    // A2 screenshots, and in S2's readiness question drawer, which had shipped with the same omission.
    assert.match(view, /className="nz-site-drawer nz-pdv-drawer"/);
    assert.match(read("app/portal/PortalReadiness.tsx"), /className="nz-site-drawer nz-pdv-drawer"/);
  });

  it("acts only in the client's own session — the staff preview shows the same plan with no controls", () => {
    assert.match(view, /const interactive=provided===undefined&&participation!==null;/);
    assert.match(view, /onUpdate=\{interactive\?/);
    // Agreeing, declining and alignment are never offered: only the moves the read model computed for the owner.
    assert.match(view, /strategy\.nextStatuses\.map/);
    assert.doesNotMatch(view, /srsRequirementIds|includeInReport/);
  });
});

describe("the CRM's gate (staff)", () => {
  it("rules on a proposal through its own commands: approve (PATCH), decline with a reason (PUT)", () => {
    assert.match(staffProposals, /requireCommandPrincipal\(request, "client\.strategy\.proposal\.approve"\)/);
    assert.match(staffProposals, /requireCommandPrincipal\(request, "client\.strategy\.proposal\.decline"\)/);
    assert.match(forms, /putBrowserCommandWithReason<\{ version: number \}>\(\s*`\/api\/isolated\/clients\/\$\{encodeURIComponent\(proposal\.clientId\)\}\/strategies\/proposals`/);
  });

  it("offers promotion into the library only to the library capability, and only after the approval succeeds", () => {
    assert.match(promote, /requireCommandPrincipal\(request, "strategy\.library\.promote"\)/);
    assert.match(workspace, /const canPromoteToLibrary = useHasCapability\("admin\.lookups"\) && writeEnabled;/);
    assert.match(forms, /canPromote \? <div className="nz-srs-picker">/);
    const approve = forms.slice(forms.indexOf("async function approve()"), forms.indexOf("async function decline()"));
    assert.ok(approve.indexOf("strategies/proposals") < approve.indexOf("reduction-strategies/promote"), "approve first, then promote");
    assert.match(approve, /if \(result\.state !== "success"\) \{ setPending\(false\); setError\(errorText\(result\)\); return; \}/, "no promotion after a failed approval");
  });

  it("keeps proposals out of the plan's counts — they have their own queue above it", () => {
    assert.match(area, /const \{ levers, library, plan, proposals \} = workspace\.strategies;/);
    assert.match(area, /\{proposals\.length > 0 \? <ProposalsQueue/);
  });
});
