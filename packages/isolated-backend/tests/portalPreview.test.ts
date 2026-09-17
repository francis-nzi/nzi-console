import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { commandGrantForRole, roleCapabilityGrants, type StaffRole } from "@nzi/contracts";

/**
 * The staff portal preview's governance rails.
 *
 * What is asserted here is mostly *absence*: no second read path, no write surface, no new
 * capability, no client-attributed audit. Those are the properties that make a preview a preview
 * rather than impersonation, and each of them is a thing that would be easy to add later without
 * noticing what it cost.
 */

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/**
 * Prose about a rule is not the rule.
 *
 * Every absence check below runs on comment-stripped source, because the explanatory comments say
 * the very words the tests look for — a note reading "not dismissible" sitting next to the banner
 * failed the test asserting the banner cannot be dismissed. Stripping first is the difference
 * between testing the code and testing my description of it.
 */
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const previewCode = () => stripComments(source("../src/portalPreview.ts"));

describe("it is a preview, not impersonation", () => {
  it("records the staff actor and says the client was not impersonated", () => {
    const code = previewCode();
    assert.match(code, /principal\.userId/, "the audit actor is the staff user");
    assert.match(code, /'staff'/, "the principal type is staff");
    assert.match(code, /portal\.preview\.open/);
    assert.match(code, /impersonated: false/);
  });

  it("never opens a portal session or resolves a portal principal", () => {
    // An action recorded against a client who was not at their desk is worse than no record,
    // because it looks like evidence.
    const code = previewCode();
    for (const forbidden of ["portal_sessions", "PortalPrincipal", "currentPortalUser", "portal_credentials"]) {
      assert.ok(!code.includes(forbidden), `the preview must not touch ${forbidden}`);
    }
  });

  it("writes nothing but the audit event", () => {
    // Read-only is a property of the code, not of the UI hiding its buttons.
    const statements = previewCode().match(/INSERT INTO|UPDATE |DELETE FROM/g) ?? [];
    assert.deepEqual(statements, ["INSERT INTO"], "exactly one write, and it is the audit row");
    assert.match(previewCode(), /INSERT INTO\s+nzi_console\.audit_events/);
  });
});

describe("the capability was already in the matrix", () => {
  it("gates on support.portal_impersonate rather than a new capability", () => {
    // The matrix has described this since v1: "enter a client's portal context … a read/preview
    // context, never portal-user credential access". Adding `portal.preview` would have split one
    // concept in two and left the older name meaning nothing.
    assert.match(previewCode(), /requireCapability\(principal, "support\.portal_impersonate"\)/);
    assert.ok(!previewCode().includes("portal.preview\""), "no second capability is introduced");
  });

  it("is held by the client-facing roles, and by no others", () => {
    const holders = (["admin", "consultant", "reviewer", "finance", "viewer"] as StaffRole[])
      .filter((role) => roleCapabilityGrants(role).some((grant) => grant.capability === "support.portal_impersonate"));
    assert.deepEqual(holders, ["admin", "consultant"]);
  });

  it("grants no data reach beyond what the holder already had", () => {
    // The scope check that makes "no new data reach" true rather than asserted: whoever can
    // preview a client can already open that client in the staff console.
    for (const role of ["admin", "consultant"] as StaffRole[]) {
      const grants = commandGrantForRole(role, "org", "user").capabilities;
      const preview = grants.find((grant) => grant.capability === "support.portal_impersonate");
      const view = grants.find((grant) => grant.capability === "client.view");
      assert.ok(preview && view, `${role} holds both`);
      assert.equal(preview.scope, view.scope, `${role}'s preview scope must not exceed its client.view scope`);
    }
  });
});

describe("one read path, not two", () => {
  it("renders from the client portal's own resolvers", () => {
    // A staff-side copy would be free to diverge, and the first time it did, a consultant would
    // be reassuring a client about something the client cannot see.
    const code = previewCode();
    assert.match(code, /getPortalClientStrategies\(db, \{ clientId/);
    assert.match(code, /getPortalClientReadiness\(db, \{ clientId/);
  });

  it("does not re-query the strategy or assessment tables itself", () => {
    const code = previewCode();
    for (const table of ["client_strategies", "srs_assessments", "srs_assessment_items", "report_compositions"]) {
      assert.ok(!code.includes(table), `the preview must read ${table} through the portal resolver, not directly`);
    }
  });

  it("checks the client scope against the database, not the request", () => {
    assert.match(previewCode(), /assertCapabilityOnClient\(db, principal, "support\.portal_impersonate", \{ clientId/);
  });
});

describe("the surface itself", () => {
  const previewSource = () => source("../../../apps/console/app/clients/[clientId]/portal-preview/PortalPreview.tsx");
  /** Comment-stripped for the absence checks — prose about a rule is not the rule, and my own
   *  note that the banner is "not dismissible" would otherwise fail the test asserting it. */
  const preview = () => stripComments(previewSource());

  it("reuses the client's own components rather than reimplementing them", () => {
    const code = preview();
    assert.match(code, /import \{ PortalReadiness \}/);
    assert.match(code, /import \{ PortalReductionPlan \}/);
  });

  it("applies the portal feature gates, so a switched-off surface is hidden here too", () => {
    const code = preview();
    assert.match(code, /portalFeatureEnabled\("portal-plan"\)/);
    assert.match(code, /portalFeatureEnabled\("portal-readiness"\)/);
  });

  it("carries a persistent banner naming the client and the read-only state", () => {
    const code = preview();
    assert.match(code, /Staff preview/);
    assert.match(code, /read-only/);
    // Not dismissible: there is no close control and no state that could hide it.
    assert.ok(!/onClose|dismiss|setHidden/i.test(code), "the banner cannot be dismissed");
  });

  it("offers no control that writes", () => {
    const code = preview();
    for (const needle of ["<form", "method=\"post\"", "fetch(", "onSubmit"]) {
      assert.ok(!code.includes(needle), `the preview must not contain ${needle}`);
    }
  });
});
