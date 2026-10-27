// Data entry D2 (R5): the AI suggestion in the console — labelled "AI suggestion · not applied", never applied by itself. In the
// import preview a person confirms it into the map (and the preview runs again); in a review move they use it, and the move confirms
// it. The route checks the capability and the client before any model call, refuses without a key, and stores only a grounded answer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(resolve(here, "..", path), "utf8");

describe("D2 (R5) — the AI suggestion's wiring", () => {
  const card = source("app/jobs/SpendSuggestionCard.tsx");
  it("is labelled and never applied: the card shows it, and only a person's button confirms, uses or dismisses it", () => {
    assert.match(card, /AI suggestion · not applied/);
    assert.match(card, /Add to the map/);
    assert.match(card, /Use this/);
    assert.match(card, /Dismiss/);
    assert.ok(!/useEffect/.test(card), "nothing is asked, confirmed or applied without a click");
  });
  it("the import preview offers it on residual lines only, and re-runs the preview after a confirmation", () => {
    const panel = source("app/jobs/SpendImportPanel.tsx");
    assert.match(panel, /review\.routing\.by === "residual" \? \(\(\) => \{/);
    assert.match(panel, /mode="confirm" onConfirmed=\{\(\) => void runPreflight\(\)\}/);
  });
  it("a review move can use it; the move then confirms it only where it lands where the suggestion said", () => {
    const control = source("app/jobs/ReallocateControl.tsx");
    assert.match(control, /mode="use"/);
    assert.match(control, /suggestion && suggestion\.categoryCode === target \? \{ suggestionId: suggestion\.suggestionId \}/);
  });
  it("the route: capability and client before the model; no key, no call; the reason goes back to the person, not to the audit", () => {
    const route = source("app/api/isolated/jobs/[jobId]/spend-suggestions/route.ts");
    assert.ok(route.indexOf("assertCapabilityOnClient") < route.indexOf("generateSpendSuggestion("), "checked before the model is called");
    assert.match(route, /if \(!apiKey\) return Response\.json\(\{ code: "AI_OFF"/);
    assert.match(route, /if \(!run\.suggestion\) return/);
    for (const action of ["confirm", "dismiss"]) {
      assert.ok(source(`app/api/isolated/jobs/[jobId]/spend-suggestions/[suggestionId]/${action}/route.ts`).includes(`requireCommandPrincipal(request, "spend_allocation.suggestion.${action}")`), action);
    }
  });
});
